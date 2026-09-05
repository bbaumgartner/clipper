import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ffmpegStatic from "ffmpeg-static";

const require = createRequire(import.meta.url);
const ffprobeStatic = require("ffprobe-static") as { path: string };

export type Probe = {
  duration: number;
  fps: number;
  width: number;
  height: number;
  videoCodec: string;
  audioCodec: string;
  audioRate: number;
  audioChannels: number;
};

function modulePath(mod: unknown): string {
  if (typeof mod === "string" && mod.length > 0) return mod;
  if (mod && typeof mod === "object" && "default" in mod) {
    const d = (mod as { default: unknown }).default;
    if (typeof d === "string" && d.length > 0) return d;
  }
  throw new Error("binary path missing");
}

function ffmpegBin(): string {
  return modulePath(ffmpegStatic);
}

function ffprobeBin(): string {
  return modulePath(ffprobeStatic.path);
}

export function runCommand(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export async function runFfmpeg(args: string[]): Promise<void> {
  const { code, stderr } = await runCommand(ffmpegBin(), [
    "-hide_banner",
    "-y",
    ...args,
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || `ffmpeg exited ${code}`);
  }
}

export async function probeFile(filePath: string): Promise<Probe> {
  const { stdout, code, stderr } = await runCommand(ffprobeBin(), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);
  if (code !== 0) {
    throw new Error(stderr.trim() || "ffprobe failed");
  }
  const json = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      avg_frame_rate?: string;
      sample_rate?: string;
      channels?: number;
    }>;
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  const audio = json.streams?.find((s) => s.codec_type === "audio");
  if (!video) throw new Error("no video stream");
  const rate = video.avg_frame_rate && video.avg_frame_rate !== "0/0"
    ? video.avg_frame_rate
    : video.r_frame_rate ?? "30/1";
  const [num, den] = rate.split("/").map(Number);
  const fps = den ? num / den : Number(rate) || 30;
  return {
    duration: Number(json.format?.duration ?? 0),
    fps,
    width: video.width ?? 0,
    height: video.height ?? 0,
    videoCodec: video.codec_name ?? "",
    audioCodec: audio?.codec_name ?? "",
    audioRate: audio?.sample_rate ? Number(audio.sample_rate) : 0,
    audioChannels: audio?.channels ?? 0,
  };
}

export async function keyframesNear(
  filePath: string,
  time: number,
  window = 2,
): Promise<number[]> {
  const from = Math.max(0, time - window);
  const to = time + window;
  const { stdout, code } = await runCommand(ffprobeBin(), [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time,flags",
    "-read_intervals",
    `${from}%${to}`,
    "-of",
    "csv=p=0",
    filePath,
  ]);
  if (code !== 0) return [];
  const times: number[] = [];
  for (const line of stdout.split("\n")) {
    const [pts, flags] = line.trim().split(",");
    if (!pts || !flags) continue;
    if (flags.includes("K")) {
      const t = Number(pts);
      if (Number.isFinite(t)) times.push(t);
    }
  }
  return times;
}

export function onKeyframe(t: number, keyframes: number[], fps: number): boolean {
  const tol = Math.max(1 / Math.max(fps, 1), 0.04);
  return keyframes.some((k) => Math.abs(k - t) <= tol);
}

const SCALE =
  "scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,setsar=1";
const STRIP_SCALE =
  "scale=96:54:force_original_aspect_ratio=decrease,pad=96:54:(ow-iw)/2:(oh-ih)/2,setsar=1";

export async function extractStill(
  input: string,
  time: number,
  output: string,
  strip = false,
): Promise<void> {
  await runFfmpeg([
    "-ss",
    Math.max(0, time).toFixed(3),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    strip ? STRIP_SCALE : SCALE,
    "-q:v",
    "4",
    output,
  ]);
  if (!fs.existsSync(output)) {
    throw new Error(`ffmpeg wrote no frame at ${time.toFixed(3)}s`);
  }
}

export async function extractThumbs(
  input: string,
  duration: number,
  outputs: string[],
  onFrame?: (index: number, total: number) => void,
): Promise<void> {
  const n = outputs.length;
  const last = duration > 0 ? Math.max(0, duration - 0.04) : 0;
  for (let i = 0; i < n; i++) {
    const t = Math.min(duration * ((i + 0.5) / n), last);
    const out = outputs[i];
    if (!out) continue;
    await extractStill(input, t, out);
    onFrame?.(i, n);
  }
}

export async function extractFilmstrip(
  input: string,
  duration: number,
  count: number,
  dir: string,
  onFrame?: (index: number) => void,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const t = duration * ((i + 0.5) / count);
    const out = `${dir}/frame_${String(i + 1).padStart(3, "0")}.jpg`;
    await extractStill(input, t, out, true);
    onFrame?.(i);
  }
}

export async function cutCopy(
  input: string,
  start: number,
  end: number,
  output: string,
): Promise<void> {
  await runFfmpeg([
    "-ss",
    start.toFixed(3),
    "-to",
    end.toFixed(3),
    "-i",
    input,
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    output,
  ]);
}

export async function cutEncode(
  input: string,
  start: number,
  end: number,
  output: string,
): Promise<void> {
  const dur = Math.max(end - start, 0.04);
  await runFfmpeg([
    "-ss",
    start.toFixed(3),
    "-i",
    input,
    "-t",
    dur.toFixed(3),
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    output,
  ]);
}

export function writeConcatList(listFile: string, files: string[]): void {
  const body = files
    .map((file) => {
      const abs = path.resolve(file);
      return `file '${abs.replaceAll("'", "'\\''")}'`;
    })
    .join("\n");
  fs.writeFileSync(listFile, `${body}\n`);
}

export async function concatCopy(listFile: string, output: string): Promise<void> {
  await runFfmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    "-movflags",
    "+faststart",
    output,
  ]);
}

export async function encodePreview(
  input: string,
  output: string,
  hasAudio: boolean,
): Promise<void> {
  const tmp = `${output}.part.mp4`;
  fs.rmSync(tmp, { force: true });
  const audio = hasAudio
    ? ["-c:a", "aac", "-b:a", "160k", "-ac", "2"]
    : ["-an"];
  const finish = () => {
    fs.renameSync(tmp, output);
  };
  if (process.platform === "darwin") {
    try {
      await runFfmpeg([
        "-i",
        input,
        "-c:v",
        "h264_videotoolbox",
        "-b:v",
        "8M",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "avc1",
        ...audio,
        "-movflags",
        "+faststart",
        tmp,
      ]);
      finish();
      return;
    } catch {
      fs.rmSync(tmp, { force: true });
    }
  }
  await runFfmpeg([
    "-i",
    input,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-tag:v",
    "avc1",
    ...audio,
    "-movflags",
    "+faststart",
    tmp,
  ]);
  finish();
}

export async function concatEncode(
  listFile: string,
  output: string,
  width: number,
  height: number,
  fps: number,
): Promise<void> {
  const evenW = width % 2 === 0 ? width : width + 1;
  const evenH = height % 2 === 0 ? height : height + 1;
  await runFfmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-vf",
    `scale=${evenW}:${evenH}:force_original_aspect_ratio=decrease,pad=${evenW}:${evenH}:(ow-iw)/2:(oh-ih)/2,fps=${Math.max(fps, 1).toFixed(3)},setsar=1`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    "192k",
    "-movflags",
    "+faststart",
    output,
  ]);
}

