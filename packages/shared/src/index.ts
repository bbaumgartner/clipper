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

export type JobEvent = {
  type: "job";
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
export const SEEK_JUMP_SEC = 5;
export const FILMSTRIP_MAX_FRAMES = 120;
export const LIST_THUMB_COUNT = 5;
