import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("streams/manager");

export type StreamStatus = "new" | "active" | "waiting" | "resolved" | "archived";

export type Stream = {
  id: string;
  title: string;
  status: StreamStatus;
  created: string;
  updated: string;
  summary: string;
  contextFiles: string[];
  keywords: string[];
  lastUserMessage: string;
  lastAssistantResponse: string;
};

export type ActiveStreamsStore = {
  version: number;
  streams: Stream[];
  maxActive: number;
  archive: Stream[];
};

const ACTIVE_STREAMS_FILENAME = "active-streams.json";
const STORE_VERSION = 1;
const DEFAULT_MAX_ACTIVE = 20;
const ARCHIVE_AFTER_DAYS = 7;

function emptyStore(): ActiveStreamsStore {
  return {
    version: STORE_VERSION,
    streams: [],
    maxActive: DEFAULT_MAX_ACTIVE,
    archive: [],
  };
}

function resolveStorePath(workspaceDir: string): string {
  return path.join(workspaceDir, ACTIVE_STREAMS_FILENAME);
}

export async function loadStreams(workspaceDir: string): Promise<ActiveStreamsStore> {
  const storePath = resolveStorePath(workspaceDir);
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as ActiveStreamsStore;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.streams)) {
      log.warn("Invalid active-streams.json, returning empty store");
      return emptyStore();
    }
    return {
      version: parsed.version ?? STORE_VERSION,
      streams: parsed.streams,
      maxActive: parsed.maxActive ?? DEFAULT_MAX_ACTIVE,
      archive: parsed.archive ?? [],
    };
  } catch (err) {
    const anyErr = err as { code?: string };
    if (anyErr.code === "ENOENT") {
      return emptyStore();
    }
    log.warn("Failed to load active-streams.json", { error: err });
    return emptyStore();
  }
}

export async function saveStreams(workspaceDir: string, store: ActiveStreamsStore): Promise<void> {
  const storePath = resolveStorePath(workspaceDir);
  const payload = JSON.stringify(store, null, 2) + "\n";
  const tmpPath = `${storePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await fs.writeFile(tmpPath, payload, { encoding: "utf-8" });
    await fs.rename(tmpPath, storePath);
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

function generateStreamId(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) + `-${Date.now().toString(36)}`
  );
}

export function createStream(params: {
  title: string;
  summary: string;
  keywords?: string[];
  contextFiles?: string[];
}): Stream {
  const now = new Date().toISOString();
  return {
    id: generateStreamId(params.title),
    title: params.title,
    status: "new",
    created: now,
    updated: now,
    summary: params.summary,
    contextFiles: params.contextFiles ?? [],
    keywords: params.keywords ?? [],
    lastUserMessage: "",
    lastAssistantResponse: "",
  };
}

export function updateStreamAfterReply(
  stream: Stream,
  userMessage: string,
  assistantResponse: string,
  summary?: string,
): Stream {
  return {
    ...stream,
    status: "active",
    updated: new Date().toISOString(),
    lastUserMessage: userMessage.slice(0, 500),
    lastAssistantResponse: assistantResponse.slice(0, 500),
    summary: summary ?? stream.summary,
  };
}

export function transitionStream(stream: Stream, newStatus: StreamStatus): Stream {
  return {
    ...stream,
    status: newStatus,
    updated: new Date().toISOString(),
  };
}

export function archiveOldStreams(store: ActiveStreamsStore): ActiveStreamsStore {
  const cutoff = Date.now() - ARCHIVE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const toArchive: Stream[] = [];
  const remaining: Stream[] = [];

  for (const stream of store.streams) {
    const updatedAt = new Date(stream.updated).getTime();
    if (stream.status === "resolved" && updatedAt < cutoff) {
      toArchive.push({ ...stream, status: "archived" });
    } else {
      remaining.push(stream);
    }
  }

  if (toArchive.length === 0) {
    return store;
  }

  log.info(`Archiving ${toArchive.length} resolved streams`);
  return {
    ...store,
    streams: remaining,
    archive: [...store.archive, ...toArchive],
  };
}

export function enforceMaxActive(store: ActiveStreamsStore): ActiveStreamsStore {
  if (store.streams.length <= store.maxActive) {
    return store;
  }

  const sorted = [...store.streams].toSorted(
    (a, b) => new Date(a.updated).getTime() - new Date(b.updated).getTime(),
  );

  const excess = sorted.length - store.maxActive;
  const toArchive = sorted.slice(0, excess).map((s) => ({ ...s, status: "archived" as const }));
  const remaining = sorted.slice(excess);

  log.info(`Max active streams exceeded, archiving ${excess} oldest`);
  return {
    ...store,
    streams: remaining,
    archive: [...store.archive, ...toArchive],
  };
}

export function findStreamById(store: ActiveStreamsStore, id: string): Stream | undefined {
  return store.streams.find((s) => s.id === id);
}

export function addStream(store: ActiveStreamsStore, stream: Stream): ActiveStreamsStore {
  return enforceMaxActive({
    ...store,
    streams: [...store.streams, stream],
  });
}

export function formatStreamsForPrompt(streams: Stream[]): string {
  if (streams.length === 0) {
    return "";
  }

  const lines = ["## Active Topic Streams", ""];
  for (let i = 0; i < streams.length; i++) {
    const s = streams[i];
    const age = formatAge(s.updated);
    lines.push(`${i + 1}. "${s.title}" [${s.status}, ${age}]`, `   ${s.summary}`);
  }
  lines.push("");
  return lines.join("\n");
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
