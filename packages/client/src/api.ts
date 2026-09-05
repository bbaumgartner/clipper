import type { Clip, Filmstrip, PlaybackStatus, Source, SseEvent } from "@clipper/shared";

declare global {
  interface Window {
    clipper?: {
      apiBase: string;
      selectFiles: () => Promise<string[]>;
      selectSavePath: () => Promise<string | null>;
    };
  }
}

export function apiBase(): string {
  const page = window.location;
  if (page.protocol === "file:" && window.clipper?.apiBase) {
    return window.clipper.apiBase;
  }
  return "";
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(`${apiBase()}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export const api = {
  sources: (sort: "date" | "name") =>
    json<{ sources: Source[] }>(`/api/sources?sort=${sort}`),
  addSource: (path: string) =>
    json<{ source: Source }>("/api/sources", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  deleteSource: (id: string) =>
    json<{ ok: boolean }>(`/api/sources/${id}`, { method: "DELETE" }),
  apply: (sourceId: string, segments: { startSec: number; endSec: number }[]) =>
    json<{ clips: Clip[] }>(`/api/sources/${sourceId}/apply`, {
      method: "POST",
      body: JSON.stringify({ segments }),
    }),
  filmstripSource: (id: string) => json<Filmstrip>(`/api/sources/${id}/filmstrip`),
  playback: (kind: "source" | "clip", id: string) =>
    json<PlaybackStatus>(`/api/${kind === "source" ? "sources" : "clips"}/${id}/playback`),
  clips: () => json<{ clips: Clip[] }>("/api/clips"),
  deleteClip: (id: string) =>
    json<{ ok: boolean }>(`/api/clips/${id}`, { method: "DELETE" }),
  clearClips: () => json<{ ok: boolean }>("/api/clips/clear", { method: "POST" }),
  retryClip: (id: string) =>
    json<{ clip: Clip }>(`/api/clips/${id}/retry`, { method: "POST" }),
  clipInSequence: (id: string) =>
    json<{ inSequence: boolean }>(`/api/clips/${id}/in-sequence`),
  filmstripClip: (id: string) => json<Filmstrip>(`/api/clips/${id}/filmstrip`),
  sequence: () => json<{ clipIds: string[] }>("/api/sequence"),
  setSequence: (clipIds: string[]) =>
    json<{ clipIds: string[] }>("/api/sequence", {
      method: "PUT",
      body: JSON.stringify({ clipIds }),
    }),
  appendSequence: (clipId: string) =>
    json<{ clipIds: string[] }>("/api/sequence/append", {
      method: "POST",
      body: JSON.stringify({ clipId }),
    }),
  moveSequence: (ids: string[], delta: number) =>
    json<{ clipIds: string[] }>("/api/sequence/move", {
      method: "POST",
      body: JSON.stringify({ ids, delta }),
    }),
  clearSequence: () =>
    json<{ clipIds: string[] }>("/api/sequence/clear", { method: "POST" }),
  exportVideo: (outputPath: string) =>
    json<{ jobId: string }>("/api/export", {
      method: "POST",
      body: JSON.stringify({ outputPath }),
    }),
};

export function thumbUrl(kind: "source" | "clip", id: string, n: number, version?: number): string {
  const q = version != null ? `?v=${version}` : "";
  return `${apiBase()}/api/${kind === "source" ? "sources" : "clips"}/${id}/thumbs/${n}${q}`;
}

export function mediaUrl(kind: "source" | "clip", id: string, proxy = false): string {
  const q = proxy ? "?proxy=1" : "";
  return `${apiBase()}/api/${kind === "source" ? "sources" : "clips"}/${id}/media${q}`;
}

export function stripFrameUrl(kind: "source" | "clip", id: string, n: number): string {
  return `${apiBase()}/api/${kind === "source" ? "sources" : "clips"}/${id}/filmstrip/${n}`;
}

export function subscribeEvents(onEvent: (event: SseEvent) => void): () => void {
  const es = new EventSource(`${apiBase()}/api/events`);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data) as SseEvent);
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}
