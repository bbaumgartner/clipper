import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";
import { FILMSTRIP_FRAME_HEIGHT, FILMSTRIP_FRAME_WIDTH } from "@clipper/shared";

function mediaType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".webm":
      return "video/webm";
    case ".ogg":
    case ".ogv":
      return "video/ogg";
    case ".mov":
      return "video/quicktime";
    case ".mkv":
      return "video/x-matroska";
    default:
      return "video/mp4";
  }
}

function pipeBytes(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
  start: number,
  end: number,
  size: number,
  status: 200 | 206,
): void {
  const chunk = end - start + 1;
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "*";
  reply.hijack();
  const headers: Record<string, string | number> = {
    "Content-Type": mediaType(filePath),
    "Content-Length": chunk,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
  };
  if (status === 206) {
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  reply.raw.writeHead(status, headers);
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on("error", () => {
    reply.raw.destroy();
  });
  req.raw.on("close", () => {
    stream.destroy();
  });
  stream.pipe(reply.raw);
}

export function streamRange(
  req: FastifyRequest,
  reply: FastifyReply,
  filePath: string,
): FastifyReply {
  if (!fs.existsSync(filePath)) {
    return reply.code(404).send({ error: "file missing" });
  }
  const size = fs.statSync(filePath).size;
  const range = req.headers.range;
  if (!range) {
    pipeBytes(req, reply, filePath, 0, size - 1, size, 200);
    return reply;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!m) {
    return reply.code(416).send({ error: "invalid range" });
  }
  const start = m[1] ? Number(m[1]) : 0;
  const end = m[2] ? Number(m[2]) : size - 1;
  if (start >= size || end >= size || start > end) {
    reply.header("Content-Range", `bytes */${size}`);
    return reply.code(416).send();
  }
  pipeBytes(req, reply, filePath, start, end, size, 206);
  return reply;
}

export function countThumbs(dir: string, prefix: string, max: number): number {
  let n = 0;
  for (let i = 0; i < max; i++) {
    if (fs.existsSync(path.join(dir, `${prefix}-${i}.jpg`))) n += 1;
  }
  return n;
}

export type StripMeta = { count: number; width: number; height: number };

export function readStripMeta(dir: string): StripMeta | null {
  try {
    const raw = fs.readFileSync(path.join(dir, "strip.json"), "utf8");
    const json = JSON.parse(raw) as { count?: unknown; width?: unknown; height?: unknown };
    if (
      typeof json.count === "number" &&
      json.count > 0 &&
      typeof json.width === "number" &&
      json.width > 0 &&
      typeof json.height === "number" &&
      json.height > 0
    ) {
      return { count: json.count, width: json.width, height: json.height };
    }
  } catch {
    /* missing or invalid */
  }
  return null;
}

export function writeStripMeta(dir: string, meta: StripMeta): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "strip.json"), JSON.stringify(meta));
}

export function stripMetaCurrent(dir: string, count: number): boolean {
  const meta = readStripMeta(dir);
  return (
    meta?.count === count &&
    meta.width === FILMSTRIP_FRAME_WIDTH &&
    meta.height === FILMSTRIP_FRAME_HEIGHT
  );
}

export function resetStripDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}
