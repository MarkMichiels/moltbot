# Design: Topic Streams — Intelligent Context Switching

**Status:** Draft
**Author:** Mark Michiels + Sero
**Date:** 2026-03-05

## Problem Statement

OpenClaw treats all messages in a DM session as a single flat conversation. When the context window fills up, older messages are compacted (summarized), losing detail. There is no concept of "topics" or "streams" — every message gets the full conversation history, regardless of what it's about.

This creates two critical failures:

1. **"Is dat gelukt?"** — After a session reset or compaction, the assistant has no idea what the user is referring to, even though a human would instantly know from context.

2. **Context pollution** — A 30-minute discussion about architecture fills the context window with tokens that are irrelevant when the user switches to asking about a meeting report.

## How a Human Would Handle This

A human assistant managing multiple topics would:

- Maintain a mental list of "active threads" (things in progress)
- Instantly classify a new message: "this is about topic X" or "this is new"
- Pull only the relevant context for that topic
- Proactively follow up: "Hey, that thing from last week — did you still need it?"

## Current Architecture (Message Pipeline)

```
Telegram message
    │
    ▼
runtime-channel.ts          ← Plugin receives message
    │
    ▼
resolve-route.ts            ← Determines agentId + sessionKey
    │                         Based on: channel + accountId + peer
    │                         DM dmScope default: "main" → all DMs = 1 session
    │
    ▼
session store               ← Loads/creates session (JSONL transcript)
    │
    ▼
envelope.ts                 ← Formats inbound metadata
    │
    ▼
system-prompt.ts            ← Assembles system prompt (SOUL.md, USER.md, etc.)
    │
    ▼
context assembly            ← Full session history → context window
    │                         If too large → compaction.ts (summarize oldest)
    │
    ▼
Model API call              ← Send everything to Claude/GPT
    │
    ▼
Reply dispatch              ← Route response back to channel
```

**Key insight:** There is NO layer between "message received" and "load full session context" that asks "what is this message about?"

## Proposed Architecture

Insert a **Topic Classification Layer** between message receipt and context assembly:

```
Telegram message
    │
    ▼
runtime-channel.ts
    │
    ▼
resolve-route.ts            ← Still resolves agentId + base sessionKey
    │
    ▼
┌───────────────────────────────────────────┐
│  NEW: Topic Stream Manager                │
│                                           │
│  1. Load active-streams.json              │
│  2. Classify message → topic (fast model) │
│  3. Load topic-specific context           │
│  4. Inject as system context              │
└───────────────────────────────────────────┘
    │
    ▼
context assembly            ← Now has topic-aware context
    │
    ▼
Model API call
    │
    ▼
Reply dispatch
    │
    ▼
┌───────────────────────────────────────────┐
│  NEW: Post-reply Stream Update            │
│                                           │
│  1. Extract key facts from response       │
│  2. Update stream state                   │
│  3. Detect new streams / close old ones   │
└───────────────────────────────────────────┘
```

## Data Model

### `active-streams.json` (workspace file)

```json
{
  "version": 1,
  "streams": [
    {
      "id": "maarten-1on1-report",
      "title": "Maarten 1-on-1 rapport verwerking",
      "status": "waiting_review",
      "created": "2026-03-04T15:00:00Z",
      "updated": "2026-03-04T18:01:00Z",
      "summary": "Claude Code heeft Maarten 1-on-1 transcript verwerkt. Twee versies rapport aangemaakt (24KB + 53KB). Google Doc en email draft status onbekend.",
      "context_files": ["memory/2026-03-04.md", "one-on-ones/TRACKING.md"],
      "keywords": ["maarten", "1-on-1", "one-on-one", "transcript", "rapport"],
      "last_user_message": "is dat gelukt?",
      "last_assistant_response": "Het rapport is gegenereerd, ja..."
    },
    {
      "id": "topic-streams-architecture",
      "title": "Topic switching architectuur voor OpenClaw",
      "status": "active",
      "created": "2026-03-05T07:25:00Z",
      "updated": "2026-03-05T09:50:00Z",
      "summary": "Mark wil intelligent context switching. Design document in progress. Branch nodig voor implementatie.",
      "context_files": ["docs/design/topic-streams.md"],
      "keywords": ["topic", "stream", "context", "switching", "architectuur"],
      "last_user_message": "...",
      "last_assistant_response": "..."
    }
  ],
  "max_active": 20,
  "archive": []
}
```

### Stream Lifecycle

```
NEW → ACTIVE → WAITING → RESOLVED → ARCHIVED
                  ↑           │
                  └───────────┘  (reopened by new message)
```

## Topic Classification

### Option A: Claude 3 Haiku via Claude Max token (Recommended)

**Tested 2026-03-05.** Claude 3 Haiku is available on the existing Claude Max subscription token (`sk-ant-oat01-...`). No additional cost.

| Model                                          | Available | Latency    | Notes                          |
| ---------------------------------------------- | --------- | ---------- | ------------------------------ |
| **Claude 3 Haiku** (`claude-3-haiku-20240307`) | ✅        | **~550ms** | Best option: fast, free on Max |
| Claude Sonnet 4 (`claude-sonnet-4-20250514`)   | ✅        | ~1.1s      | Overkill for classification    |
| Claude 3.5 Haiku                               | ❌        | -          | Not available on Max token     |
| Claude 4 Haiku                                 | ❌        | -          | Not available on Max token     |
| Gemini 2.0 Flash                               | ✅        | ~1.8s      | Separate API key, slower       |

**Input:** ~150-250 tokens (stream list + message)
**Output:** ~5 tokens (stream number or "NEW")
**Cost:** Included in Claude Max subscription

**Classification prompt:**

```
You classify user messages into conversation streams. Consider message content,
keywords, stream status, and recency.

Active streams:
1. "Maarten 1-on-1 rapport" [status: waiting_review, 14h ago] - Claude Code
   processed meeting transcript. Two report versions created. Unknown if Google
   Doc and email draft were completed.
2. "Topic switching architectuur" [status: active, 2h ago] - Discussing how to
   add topic detection to OpenClaw.

User message: "is dat gelukt?"

Which stream does this belong to? Consider:
- "is dat gelukt?" implies checking on something with an unknown outcome
- Stream status (waiting_review = likely needs follow-up)
- Recency matters but is not the only factor

Reply with ONLY the stream number or NEW.
```

**Lessons from testing:**

- Ambiguous messages like "is dat gelukt?" depend heavily on stream metadata quality
- Status descriptions ("outcome unknown", "waiting_review") are critical for correct classification
- All tested models (Haiku, Sonnet, Gemini Flash) gave identical classifications
- Recency bias is strong — ensure status metadata compensates for this

### Option B: Keyword + Heuristic (Fallback)

If Haiku is unavailable or for offline/cost-free operation:

- Match message against stream keywords (fuzzy match)
- Weight by recency (more recent streams score higher)
- If time gap < 5 min and no topic change signal → assume same stream
- If no match → create new stream

### Option C: Embedding Similarity

Embed the message and compare against stream summaries.
More accurate than keywords but requires embedding service.
Currently disabled in our setup (grep + RAG preferred over local embeddings).

## Context Injection

Instead of loading the full session history, the Topic Stream Manager:

1. **Always loads:** System prompt, workspace files (SOUL.md etc.)
2. **Loads for matched stream:**
   - Stream summary (compact)
   - Last N messages in that stream
   - Referenced context files
3. **Does NOT load:** Messages from other streams

This dramatically reduces context usage per turn.

## Implementation Plan

### Phase 1: Stream Tracking (no routing changes)

- Create `active-streams.json` in workspace
- After each reply, update stream state (via post-processing)
- On session start, load streams for awareness
- **Impact:** Zero risk. Just adds awareness without changing routing.

### Phase 2: Topic Classification

- Add fast model classification on inbound messages
- Log classifications (don't act on them yet)
- Validate accuracy over real conversations
- **Impact:** Low risk. Read-only, just logging.

### Phase 3: Context-Aware Loading

- Use classification to load stream-specific context
- Fall back to full context if classification confidence is low
- **Impact:** Medium risk. Changes what the model sees.

### Phase 4: Proactive Follow-up

- During heartbeats, scan streams for stale items
- Proactively remind user about waiting/blocked streams
- **Impact:** Low risk. Additive behavior.

## Integration Points in Codebase

| File                                 | Change                                         | Phase |
| ------------------------------------ | ---------------------------------------------- | ----- |
| `src/agents/workspace.ts`            | Load `active-streams.json` on session start    | 1     |
| `src/agents/system-prompt.ts`        | Inject stream summary into system context      | 1, 3  |
| `src/auto-reply/envelope.ts`         | Add stream classification metadata             | 2     |
| `src/agents/compaction.ts`           | Stream-aware compaction (per-stream summaries) | 3     |
| `src/infra/heartbeat-runner.ts`      | Proactive stream follow-up                     | 4     |
| NEW: `src/streams/classifier.ts`     | Topic classification logic                     | 2     |
| NEW: `src/streams/manager.ts`        | Stream CRUD + lifecycle                        | 1     |
| NEW: `src/streams/context-loader.ts` | Stream-specific context assembly               | 3     |

## Configuration

```json
{
  "agents": {
    "defaults": {
      "streams": {
        "enabled": true,
        "classifier": {
          "provider": "anthropic",
          "model": "claude-3-haiku-20240307",
          "fallback": "keywords"
        },
        "maxActive": 20,
        "archiveAfterDays": 7,
        "proactiveReminders": true
      }
    }
  }
}
```

**Note:** The classifier reuses the existing Anthropic auth profile from the agent config. No additional API keys needed.

## Risks & Mitigations

| Risk                       | Impact               | Mitigation                                                  |
| -------------------------- | -------------------- | ----------------------------------------------------------- |
| Misclassification          | Wrong context loaded | Confidence threshold; fallback to full context              |
| Added latency              | 200ms per message    | Fast model; async classification                            |
| Stream explosion           | Too many streams     | Max limit + auto-archive                                    |
| Breaking existing behavior | Everything breaks    | Feature flag; opt-in; branch                                |
| Upstream merge conflicts   | Hard to maintain     | Minimal changes to existing files; new files where possible |

## Open Questions

1. Should streams persist across gateway restarts? (Yes — file-based)
2. Should the user be able to explicitly switch streams? (`/stream maarten`)
3. How to handle messages that span multiple streams?
4. Should sub-agents inherit stream context?

## Future: Upstream Feature Request

After validation, propose to OpenClaw upstream as:

- Problem description with real user examples
- Architecture overview (not code)
- Performance/cost data from our testing
- Clear value proposition: better context management = less token waste = better UX

Let the maintainer decide implementation approach for upstream.
