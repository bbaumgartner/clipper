import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { filmstripFrameFile } from "@clipper/shared";
import { ClipperApp } from "./app.js";
import { streamRange } from "./media.js";

export type StartServerOptions = {
  host?: string;
  port?: number;
  dataDir: string;
};

const addSourceBody = z.object({ path: z.string().min(1) });
const applyBody = z.object({
  segments: z.array(
    z.object({
      startSec: z.number(),
      endSec: z.number(),
    }),
  ),
});
const sequenceBody = z.object({ clipIds: z.array(z.string()) });
const moveBody = z.object({
  ids: z.array(z.string()).min(1),
  delta: z.number().int(),
});
const exportBody = z.object({ outputPath: z.string().min(1) });
const appendBody = z.object({ clipId: z.string().min(1) });

export async function startServer(opts: StartServerOptions): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const host = opts.host ?? "127.0.0.1";
  const app = new ClipperApp(opts.dataDir);
  const fastify = Fastify({ logger: false });
  await fastify.register(cors, { origin: true });

  fastify.get("/api/sources", async (req) => {
    const q = req.query as { sort?: string };
    const sort = q.sort === "name" ? "name" : "date";
    return { sources: app.listSources(sort) };
  });

  fastify.post("/api/sources", async (req, reply) => {
    const parsed = addSourceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    try {
      const source = await app.addSource(parsed.data.path);
      return { source };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.delete("/api/sources/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      app.deleteSource(id);
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get("/api/sources/:id/playback", async (req, reply) => {
    const { id } = req.params as { id: string };
    const status = app.playbackStatus("source", id);
    if (!status) return reply.code(404).send({ error: "not found" });
    return status;
  });

  fastify.get("/api/sources/:id/media", async (req, reply) => {
    const { id } = req.params as { id: string };
    const proxy = (req.query as { proxy?: string }).proxy === "1";
    const file = app.mediaFile("source", id, proxy);
    if (file === "missing") return reply.code(404).send({ error: "not found" });
    if (file === "encoding") {
      return reply.code(503).header("Retry-After", "1").send({ error: "encoding preview" });
    }
    return streamRange(req, reply, file);
  });

  fastify.get("/api/sources/:id/thumbs/:n", async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const file = app.sourceThumbPath(id, Number(n));
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not found" });
    return reply.type("image/jpeg").send(fs.createReadStream(file));
  });

  fastify.get("/api/sources/:id/filmstrip", async (req) => {
    const { id } = req.params as { id: string };
    app.ensureFilmstrip("source", id);
    return app.getFilmstrip("source", id);
  });

  fastify.get("/api/sources/:id/filmstrip/:n", async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const file = path.join(app.sourceStripDir(id), filmstripFrameFile(Number(n)));
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not found" });
    return reply.type("image/jpeg").send(fs.createReadStream(file));
  });

  fastify.post("/api/sources/:id/apply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = applyBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    try {
      const clips = await app.applySegments(id, parsed.data.segments);
      return { clips };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get("/api/clips", async () => ({ clips: app.listClips() }));

  fastify.post("/api/clips/clear", async () => {
    app.clearClips();
    return { ok: true };
  });

  fastify.delete("/api/clips/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      app.deleteClip(id);
      return { ok: true };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.post("/api/clips/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const clip = await app.retryClip(id);
      return { clip };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get("/api/clips/:id/in-sequence", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!app.getClip(id)) return reply.code(404).send({ error: "not found" });
    return { inSequence: app.clipInSequence(id) };
  });

  fastify.get("/api/clips/:id/playback", async (req, reply) => {
    const { id } = req.params as { id: string };
    const status = app.playbackStatus("clip", id);
    if (!status) return reply.code(404).send({ error: "not found" });
    return status;
  });

  fastify.get("/api/clips/:id/media", async (req, reply) => {
    const { id } = req.params as { id: string };
    const proxy = (req.query as { proxy?: string }).proxy === "1";
    const file = app.mediaFile("clip", id, proxy);
    if (file === "missing") return reply.code(404).send({ error: "not ready" });
    if (file === "encoding") {
      return reply.code(503).header("Retry-After", "1").send({ error: "encoding preview" });
    }
    return streamRange(req, reply, file);
  });

  fastify.get("/api/clips/:id/thumbs/:n", async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const file = app.clipThumbPath(id, Number(n));
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not found" });
    return reply.type("image/jpeg").send(fs.createReadStream(file));
  });

  fastify.get("/api/clips/:id/filmstrip", async (req) => {
    const { id } = req.params as { id: string };
    app.ensureFilmstrip("clip", id);
    return app.getFilmstrip("clip", id);
  });

  fastify.get("/api/clips/:id/filmstrip/:n", async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const file = path.join(app.clipStripDir(id), filmstripFrameFile(Number(n)));
    if (!fs.existsSync(file)) return reply.code(404).send({ error: "not found" });
    return reply.type("image/jpeg").send(fs.createReadStream(file));
  });

  fastify.get("/api/sequence", async () => ({ clipIds: app.listSequenceIds() }));

  fastify.put("/api/sequence", async (req, reply) => {
    const parsed = sequenceBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    try {
      return { clipIds: app.setSequence(parsed.data.clipIds) };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.post("/api/sequence/append", async (req, reply) => {
    const parsed = appendBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    try {
      return { clipIds: app.appendSequence(parsed.data.clipId) };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.post("/api/sequence/move", async (req, reply) => {
    const parsed = moveBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    return { clipIds: app.moveSequence(parsed.data.ids, parsed.data.delta) };
  });

  fastify.post("/api/sequence/clear", async () => ({ clipIds: app.clearSequence() }));

  const exportJobs = new Map<string, { status: string; error?: string }>();

  fastify.post("/api/export", async (req, reply) => {
    const parsed = exportBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid body" });
    try {
      const jobId = await app.exportSequence(parsed.data.outputPath);
      exportJobs.set(jobId, { status: "ready" });
      return { jobId };
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500;
      return reply.code(status).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  fastify.get("/api/export/:jobId", async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = exportJobs.get(jobId);
    if (!job) return reply.code(404).send({ error: "not found" });
    return job;
  });

  fastify.get("/api/events", async (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    reply.raw.write("\n");
    const send = (event: unknown) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const off = app.events.onEvent(send);
    req.raw.on("close", () => {
      off();
    });
  });

  const address = await fastify.listen({ host, port: opts.port ?? 47281 });
  const port = Number(new URL(address.startsWith("http") ? address : `http://${address}`).port);
  return {
    port,
    close: () => fastify.close(),
  };
}
