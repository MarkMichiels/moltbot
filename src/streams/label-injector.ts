/**
 * Stream label injector — prepends stream topic label to outbound replies.
 *
 * Used as post-processing step after the model generates a reply,
 * injecting "📌 Stream: <title>" before the reply text.
 *
 * This runs independently of the model — the model doesn't need to
 * know about streams or format any labels.
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { classifyMessage, type ClassificationResult } from "./classifier.js";
import { loadStreams, saveStreams, type Stream } from "./manager.js";

const log = createSubsystemLogger("streams/label-injector");

export type StreamLabelResult = {
  label: string | null;
  classification: ClassificationResult | null;
  matchedStream: Stream | null;
};

/**
 * Classify an inbound message and return the stream label to prepend.
 * Also updates the matched stream's lastUserMessage and timestamp.
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
      return { label: null, classification, matchedStream: null };
    }

    const matchedStream = activeStreams[classification.streamIndex];
    if (!matchedStream) {
      log.warn("Classification returned invalid stream index", {
        streamIndex: classification.streamIndex,
      });
      return { label: null, classification, matchedStream: null };
    }

    // Update stream metadata
    const freshStore = await loadStreams(workspaceDir);
    const streamInStore = freshStore.streams.find((s) => s.id === matchedStream.id);
    if (streamInStore) {
      streamInStore.lastUserMessage = userMessage.slice(0, 200);
      streamInStore.updated = new Date().toISOString();
      if (streamInStore.status === "waiting") {
        streamInStore.status = "active";
      }
      await saveStreams(workspaceDir, freshStore);
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
 * Prepend stream label to reply text.
 * Returns the original text if no label is available.
 */
export function prependStreamLabel(text: string, label: string | null): string {
  if (!label) {
    return text;
  }
  return `${label}\n\n${text}`;
}
