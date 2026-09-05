export const VIDEO_EXTENSIONS = ["mp4", "mov", "mkv", "webm", "m4v", "avi"] as const;

export type ClipStatus = "pending" | "ready" | "failed";

export type Source = {
  id: string;
  path: string;
  name: string;
  duration: number;
  fps: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  audioRate: number;
  audioChannels: number;
  mtime: number;
  addedAt: number;
  broken: boolean;
  thumbCount: number;
};

export type Clip = {
  id: string;
  sourceId: string | null;
  sourceName: string | null;
  startSec: number;
  endSec: number;
  status: ClipStatus;
  error: string | null;
  createdAt: number;
  duration: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string;
  audioRate: number;
  audioChannels: number;
  thumbCount: number;
};

export type SequenceItem = {
  clipId: string;
  position: number;
};

export type Segment = {
  startSec: number;
  endSec: number;
};

export type FilmstripFrame = {
  index: number;
  time: number;
  ready: boolean;
};

export type Filmstrip = {
  kind: "source" | "clip";
  id: string;
  duration: number;
  count: number;
  readyCount: number;
  frames: FilmstripFrame[];
};

export type JobKind = "preview" | "thumbs" | "cut";

export type JobEvent = {
  type: "job";
  kind?: JobKind;
  clipId?: string;
  sourceId?: string;
  status: "pending" | "running" | "ready" | "failed";
  progress?: number;
  message?: string;
};

export type ClipEvent = {
  type: "clip";
  clip: Clip;
};

export type SourceEvent = {
  type: "source";
  source: Source;
};

export type FilmstripEvent = {
  type: "filmstrip";
  kind: "source" | "clip";
  id: string;
  readyCount: number;
  count: number;
};

export type SequenceEvent = {
  type: "sequence";
  clipIds: string[];
};

export type ExportEvent = {
  type: "export";
  jobId: string;
  status: "pending" | "running" | "ready" | "failed";
  progress?: number;
  message?: string;
};

export type SseEvent =
  | JobEvent
  | ClipEvent
  | SourceEvent
  | FilmstripEvent
  | SequenceEvent
  | ExportEvent;

export type SourcesQuery = {
  sort: "date" | "name";
};

export type PlaybackStatus = {
  ready: boolean;
  encoding: boolean;
  proxy: boolean;
  error: string | null;
};

const HTML5_SAFE_VIDEO = new Set(["h264", "vp8", "vp9", "av1", "av01"]);
const HTML5_AUDIO = new Set(["", "aac", "mp3", "opus", "vorbis", "flac", "mp4a"]);
const HTML5_EXT = new Set([".mp4", ".m4v", ".webm"]);

function html5Playable(filePath: string, videoCodec: string, audioCodec: string): boolean {
  const dot = filePath.lastIndexOf(".");
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : "";
  const video = videoCodec.toLowerCase();
  const audio = audioCodec.toLowerCase();
  return HTML5_SAFE_VIDEO.has(video) && HTML5_AUDIO.has(audio) && HTML5_EXT.has(ext);
}

/** Chromium can play this without a transcode in typical Electron builds. */
export function isHtml5Safe(filePath: string, videoCodec: string, audioCodec: string): boolean {
  return html5Playable(filePath, videoCodec, audioCodec);
}

export const CUT_EPSILON_SEC = 0.05;
export const SEEK_STEP_SEC = 0.5;
export const SEEK_FINE_SEC = SEEK_STEP_SEC / 10;
export const PLAYBACK_FINE_RATE = 0.1;
export const FILMSTRIP_NORMAL_INTERVAL_SEC = 10;
export const FILMSTRIP_FINE_INTERVAL_SEC = 2;
export const FILMSTRIP_FINE_STEP = Math.round(
  FILMSTRIP_NORMAL_INTERVAL_SEC / FILMSTRIP_FINE_INTERVAL_SEC,
);
export const FILMSTRIP_MAG_RADIUS_SEC = 10;
export const FILMSTRIP_FRAME_PAD = 5;
export const FILMSTRIP_FRAME_WIDTH = 192;
export const FILMSTRIP_FRAME_HEIGHT = 108;
export const LIST_THUMB_MIN = 5;
export const LIST_THUMB_MAX = 20;
export const LIST_THUMB_WIDTH = 72;
export const LIST_THUMB_GAP = 2;

/** How many list thumbs to render for a strip of the given CSS width. */
export function listThumbVisibleCount(widthPx: number, storedCount: number): number {
  const width = Number.isFinite(widthPx) ? Math.max(0, widthPx) : 0;
  const stored = Number.isFinite(storedCount) ? Math.max(0, storedCount) : 0;
  const fitted = Math.floor((width + LIST_THUMB_GAP) / (LIST_THUMB_WIDTH + LIST_THUMB_GAP));
  const want = Math.max(LIST_THUMB_MIN, fitted);
  const cap = stored > 0 ? Math.min(stored, LIST_THUMB_MAX) : LIST_THUMB_MIN;
  return Math.min(want, cap, LIST_THUMB_MAX);
}

/** Evenly spaced indices into a stored thumb set for a visible count. */
export function listThumbIndices(visible: number, stored: number): number[] {
  const v = Math.max(0, Math.floor(visible));
  const n = Math.max(0, Math.floor(stored));
  if (v <= 0 || n <= 0) return [];
  if (v === 1 || n === 1) return [0];
  if (v >= n) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: v }, (_, i) => Math.round((i * (n - 1)) / (v - 1)));
}

export function filmstripCoarseCount(duration: number): number {
  if (!(duration > 0)) return 1;
  return Math.max(1, Math.round(duration / FILMSTRIP_NORMAL_INTERVAL_SEC));
}

export function filmstripFineCount(duration: number): number {
  return filmstripCoarseCount(duration) * FILMSTRIP_FINE_STEP;
}

export function filmstripFrameTime(index: number, count: number, duration: number): number {
  if (count <= 0) return 0;
  const last = duration > 0 ? Math.max(0, duration - 0.04) : 0;
  return Math.min(duration * ((index + 0.5) / count), last);
}

export function filmstripFrameFile(index: number): string {
  return `frame_${String(index + 1).padStart(FILMSTRIP_FRAME_PAD, "0")}.jpg`;
}

/** Coarse (10s) frames first so the normal strip can appear before the 2s fill-in. */
export function filmstripExtractOrder(count: number): number[] {
  const n = Math.max(0, Math.floor(count));
  const first: number[] = [];
  const rest: number[] = [];
  for (let i = 0; i < n; i++) {
    (i % FILMSTRIP_FINE_STEP === 0 ? first : rest).push(i);
  }
  return first.concat(rest);
}

/** Normal: every 10s frame. Shift: also every 2s frame inside the magnify radius. */
export function filmstripVisibleIndices(
  count: number,
  duration: number,
  currentTime: number,
  magnify: boolean,
  radiusSec = FILMSTRIP_MAG_RADIUS_SEC,
): number[] {
  const n = Math.max(0, Math.floor(count));
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i % FILMSTRIP_FINE_STEP === 0) {
      out.push(i);
      continue;
    }
    if (!magnify) continue;
    const t = filmstripFrameTime(i, n, duration);
    if (Math.abs(t - currentTime) <= radiusSec) out.push(i);
  }
  return out;
}
