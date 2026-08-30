import fs from "node:fs";
import path from "node:path";
import type { FastifyReply, FastifyRequest } from "fastify";

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

export function filmstripReadyCount(dir: string, count: number): number {
  let n = 0;
  for (let i = 1; i <= count; i++) {
    const name = `frame_${String(i).padStart(3, "0")}.jpg`;
    if (fs.existsSync(path.join(dir, name))) n += 1;
  }
  return n;
}
