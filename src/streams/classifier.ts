import { ensureAuthProfileStore, resolveApiKeyForProfile } from "../agents/auth-profiles.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { Stream } from "./manager.js";

const log = createSubsystemLogger("streams/classifier");

const CLASSIFIER_MODEL = "claude-3-haiku-20240307";
const CLASSIFIER_MAX_TOKENS = 16;
const SYNTHESIZER_MAX_TOKENS = 150;
const CLASSIFIER_TIMEOUT_MS = 5_000;
const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";

export type ClassificationResult = {
  streamIndex: number | null;
  isNew: boolean;
  confidence: "high" | "low";
  latencyMs: number;
};

function buildClassificationPrompt(streams: Stream[], userMessage: string): string {
  if (streams.length === 0) {
    return "";
  }

  const streamLines = streams.map((s, i) => {
    const age = formatAge(s.updated);
    return `${i + 1}. "${s.title}" [status: ${s.status}, ${age}] - ${s.summary}`;
  });

  return [
    "You classify user messages into conversation streams. Consider message content, keywords, stream status, and recency.",
    "",
    "Active streams:",
    ...streamLines,
    "",
    `User message: "${userMessage}"`,
    "",
    "Which stream does this belong to? Consider:",
    "- Message content and keywords matching stream topics",
    "- Stream status (waiting/waiting_review = likely needs follow-up)",
    "- Recency matters but is not the only factor",
    "- Ambiguous short messages like 'is dat gelukt?' likely refer to streams with uncertain outcomes",
    "",
    "Reply with ONLY the stream number (e.g. '1') or 'NEW' if it doesn't match any stream.",
  ].join("\n");
}

function formatAge(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) {
    return `${diffMin}m ago`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return `${diffHours}h ago`;
  }
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

async function resolveAnthropicApiKey(agentDir?: string): Promise<string | null> {
  const store = ensureAuthProfileStore(agentDir);
  const cfg = loadConfig();

  // Try anthropic profiles in order of preference
  const anthropicProfiles = Object.keys(store.profiles).filter(
    (id) => store.profiles[id].provider === "anthropic",
  );

  for (const profileId of anthropicProfiles) {
    const result = await resolveApiKeyForProfile({ store, profileId, cfg });
    if (result?.apiKey) {
      return result.apiKey;
    }
  }

  return null;
}

export async function classifyMessage(
  streams: Stream[],
  userMessage: string,
  agentDir?: string,
): Promise<ClassificationResult> {
  const start = Date.now();

  if (streams.length === 0) {
    return { streamIndex: null, isNew: true, confidence: "high", latencyMs: Date.now() - start };
  }

  // Try keyword-based classification first as fast path
  const keywordMatch = classifyByKeywords(streams, userMessage);
  if (keywordMatch !== null && keywordMatch.confidence === "high") {
    log.info("Keyword classifier matched", { streamIndex: keywordMatch.streamIndex });
    return { ...keywordMatch, latencyMs: Date.now() - start };
  }

  // Fall back to Haiku LLM classification
  try {
    const apiKey = await resolveAnthropicApiKey(agentDir);
    if (!apiKey) {
      log.warn("No Anthropic API key available, falling back to keywords");
      return (
        keywordMatch ?? {
          streamIndex: null,
          isNew: true,
          confidence: "low",
          latencyMs: Date.now() - start,
        }
      );
    }

    const result = await classifyWithHaiku(streams, userMessage, apiKey);
    return { ...result, latencyMs: Date.now() - start };
  } catch (err) {
    log.warn("Haiku classification failed, falling back to keywords", { error: err });
    return (
      keywordMatch ?? {
        streamIndex: null,
        isNew: true,
        confidence: "low",
        latencyMs: Date.now() - start,
      }
    );
  }
}

async function classifyWithHaiku(
  streams: Stream[],
  userMessage: string,
  apiKey: string,
): Promise<Omit<ClassificationResult, "latencyMs">> {
  const prompt = buildClassificationPrompt(streams, userMessage);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

  try {
    const response = await fetch(ANTHROPIC_MESSAGES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLASSIFIER_MODEL,
        max_tokens: CLASSIFIER_MAX_TOKENS,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      log.warn("Haiku API error", { status: response.status, body: body.slice(0, 200) });
      return { streamIndex: null, isNew: true, confidence: "low" };
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };

    const text = data.content?.[0]?.text?.trim().toUpperCase() ?? "";
    log.info("Haiku classification result", { raw: text });

    if (text === "NEW") {
      return { streamIndex: null, isNew: true, confidence: "high" };
    }

    const num = parseInt(text, 10);
    if (!isNaN(num) && num >= 1 && num <= streams.length) {
      return { streamIndex: num - 1, isNew: false, confidence: "high" };
    }

    log.warn("Unexpected Haiku response", { text });
    return { streamIndex: null, isNew: true, confidence: "low" };
  } finally {
    clearTimeout(timeout);
  }
}

export type StreamSynthesis = {
  title: string;
  keywords: string[];
  summary: string;
};

/**
 * Use Haiku to synthesize a stream title, keywords, and summary from a
 * user message + assistant response pair.
 */
export async function synthesizeStream(
  userMessage: string,
  assistantResponse: string,
  agentDir?: string,
): Promise<StreamSynthesis | null> {
  try {
    const apiKey = await resolveAnthropicApiKey(agentDir);
    if (!apiKey) {
      return null;
    }

    const prompt = [
      "Given this conversation exchange, create a short topic label for tracking.",
      "",
      `User: "${userMessage.slice(0, 300)}"`,
      `Assistant: "${assistantResponse.slice(0, 300)}"`,
      "",
      "Reply with ONLY valid JSON (no markdown):",
      '{"title": "Short descriptive title (max 6 words)", "keywords": ["keyword1", "keyword2", "keyword3"], "summary": "One sentence summary of the topic"}',
    ].join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

    try {
      const response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: CLASSIFIER_MODEL,
          max_tokens: SYNTHESIZER_MAX_TOKENS,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };

      const text = data.content?.[0]?.text?.trim() ?? "";
      const parsed = JSON.parse(text) as StreamSynthesis;

      if (parsed.title && Array.isArray(parsed.keywords)) {
        log.info("Stream synthesized", { title: parsed.title });
        return parsed;
      }
      return null;
    } finally {
      clearTimeout(timeout);
    }
  } catch (err) {
    log.warn("Stream synthesis failed", { error: err });
    return null;
  }
}

/**
 * Use Haiku to update a stream summary based on new conversation context.
 */
export async function updateStreamSummary(
  stream: Stream,
  userMessage: string,
  assistantResponse: string,
  agentDir?: string,
): Promise<string | null> {
  try {
    const apiKey = await resolveAnthropicApiKey(agentDir);
    if (!apiKey) {
      return null;
    }

    const prompt = [
      `Current topic: "${stream.title}"`,
      `Current summary: "${stream.summary}"`,
      "",
      `New exchange:`,
      `User: "${userMessage.slice(0, 200)}"`,
      `Assistant: "${assistantResponse.slice(0, 200)}"`,
      "",
      "Write an updated one-sentence summary incorporating the new information. Reply with ONLY the summary text, no quotes.",
    ].join("\n");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);

    try {
      const response = await fetch(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: CLASSIFIER_MODEL,
          max_tokens: SYNTHESIZER_MAX_TOKENS,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        return null;
      }

      const data = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };

      return data.content?.[0]?.text?.trim() ?? null;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return null;
  }
}

function classifyByKeywords(streams: Stream[], userMessage: string): ClassificationResult | null {
  const messageLower = userMessage.toLowerCase();
  const messageWords = new Set(messageLower.split(/\s+/));

  let bestIndex = -1;
  let bestScore = 0;

  for (let i = 0; i < streams.length; i++) {
    const stream = streams[i];
    let score = 0;

    for (const keyword of stream.keywords) {
      if (messageLower.includes(keyword.toLowerCase())) {
        score += 2;
      }
    }

    // Title word overlap
    const titleWords = stream.title.toLowerCase().split(/\s+/);
    for (const word of titleWords) {
      if (word.length > 2 && messageWords.has(word)) {
        score += 1;
      }
    }

    // Recency bonus (decays over hours)
    const hoursAgo = (Date.now() - new Date(stream.updated).getTime()) / 3_600_000;
    if (hoursAgo < 1) {
      score += 1;
    }

    // Time gap heuristic: if < 5 min since last update, bias toward same stream
    if (hoursAgo < 5 / 60) {
      score += 3;
    }

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  // High confidence requires strong keyword evidence (multiple distinct matches)
  // to avoid bypassing the Haiku LLM classifier on weak signals
  if (bestScore >= 6) {
    return { streamIndex: bestIndex, isNew: false, confidence: "high", latencyMs: 0 };
  }
  if (bestScore >= 2) {
    return { streamIndex: bestIndex, isNew: false, confidence: "low", latencyMs: 0 };
  }

  return null;
}
