/**
 * Stream label injector — classifies messages, labels replies, and manages stream lifecycle.
 *
 * Pre-reply:  classifyAndLabel() → determines which stream the message belongs to
 * Post-reply: postReplyStreamUpdate() → creates new streams or updates existing ones
 *
 * Both run independently of the model — the model doesn't need to
 * know about streams or format any labels.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  classifyMessage,
  synthesizeStream,
  updateStreamSummary,
  type ClassificationResult,
} from "./classifier.js";
import {
  addStream,
  archiveOldStreams,
  createStream,
  loadStreams,
  saveStreams,
  type Stream,
} from "./manager.js";

const log = createSubsystemLogger("streams/label-injector");

export type StreamLabelResult = {
  label: string | null;
  classification: ClassificationResult | null;
  matchedStream: Stream | null;
};

/**
 * Classify an inbound message and return the stream label to prepend.
 */
export async function classifyAndLabel(
  workspaceDir: string,
  userMessage: string,
  agentDir?: string,
): Promise<StreamLabelResult> {
  try {
    const store = await loadStreams(workspaceDir);
    const activeStreams = store.streams.filter(
      (s) => s.status !== "archived" && s.status !== "resolved",
    );

    if (activeStreams.length === 0) {
      log.debug("No active streams, skipping classification");
      return { label: null, classification: null, matchedStream: null };
    }

    const classification = await classifyMessage(activeStreams, userMessage, agentDir);

    if (classification.isNew || classification.streamIndex === null) {
      log.info("Message classified as NEW topic", {
        confidence: classification.confidence,
        latencyMs: classification.latencyMs,
      });
      return { label: "📌 _Nieuw onderwerp_", classification, matchedStream: null };
    }

    const matchedStream = activeStreams[classification.streamIndex];
    if (!matchedStream) {
      log.warn("Classification returned invalid stream index", {
        streamIndex: classification.streamIndex,
      });
      return { label: null, classification, matchedStream: null };
    }

    const label = `📌 _Stream: ${matchedStream.title}_`;
    log.info("Stream label assigned", {
      stream: matchedStream.id,
      title: matchedStream.title,
      confidence: classification.confidence,
      latencyMs: classification.latencyMs,
    });

    return { label, classification, matchedStream };
  } catch (err) {
    log.warn("Stream label injection failed (non-fatal)", { error: err });
    return { label: null, classification: null, matchedStream: null };
  }
}

/**
 * Post-reply hook: update existing stream or create a new one.
 *
 * Called after the model has generated a reply, so we have both
 * the user message and assistant response.
 */
export async function postReplyStreamUpdate(
  workspaceDir: string,
  userMessage: string,
  assistantResponse: string,
  labelResult: StreamLabelResult,
  agentDir?: string,
): Promise<void> {
  try {
    if (labelResult.matchedStream) {
      // Update existing stream
      const store = await loadStreams(workspaceDir);
      const streamInStore = store.streams.find((s) => s.id === labelResult.matchedStream!.id);
      if (streamInStore) {
        streamInStore.lastUserMessage = userMessage.slice(0, 200);
        streamInStore.lastAssistantResponse = assistantResponse.slice(0, 200);
        streamInStore.updated = new Date().toISOString();
        if (streamInStore.status === "waiting" || streamInStore.status === "new") {
          streamInStore.status = "active";
        }

        // Update summary via Haiku (fire-and-forget, non-blocking)
        updateStreamSummary(streamInStore, userMessage, assistantResponse, agentDir)
          .then((newSummary) => {
            if (newSummary) {
              // Re-read, update, re-save (avoid race conditions with simple retry)
              loadStreams(workspaceDir)
                .then((freshStore) => {
                  const s = freshStore.streams.find((x) => x.id === labelResult.matchedStream!.id);
                  if (s) {
                    s.summary = newSummary;
                    return saveStreams(workspaceDir, freshStore);
                  }
                })
                .catch(() => {});
            }
          })
          .catch(() => {});

        await saveStreams(workspaceDir, archiveOldStreams(store));
        log.info("Stream updated after reply", { stream: streamInStore.id });
      }
    } else if (
      labelResult.classification?.isNew &&
      userMessage.length > 10 &&
      assistantResponse.length > 20
    ) {
      // Create new stream via Haiku synthesis
      const synthesis = await synthesizeStream(userMessage, assistantResponse, agentDir);
      if (synthesis) {
        const newStream = createStream({
          title: synthesis.title,
          summary: synthesis.summary,
          keywords: synthesis.keywords,
        });
        newStream.lastUserMessage = userMessage.slice(0, 200);
        newStream.lastAssistantResponse = assistantResponse.slice(0, 200);
        newStream.status = "active";

        const store = await loadStreams(workspaceDir);
        const updatedStore = addStream(archiveOldStreams(store), newStream);
        await saveStreams(workspaceDir, updatedStore);

        log.info("New stream created", {
          id: newStream.id,
          title: newStream.title,
          keywords: newStream.keywords,
        });
      }
    }
  } catch (err) {
    log.warn("Post-reply stream update failed (non-fatal)", { error: err });
  }
}

/**
 * Prepend stream label to reply text.
 * Returns the original text if no label is available.
 */
export function prependStreamLabel(text: string, label: string | null): string {
  if (!label) {
    return text;
  }
  return `${label}\n\n${text}`;
}
