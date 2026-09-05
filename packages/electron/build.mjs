import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const outDir = path.join(dir, "dist");
const resourcesDir = path.join(dir, "resources");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(resourcesDir, { recursive: true });

await esbuild.build({
  absWorkingDir: dir,
  entryPoints: ["src/main.ts"],
  outfile: path.join(outDir, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["electron", "ffmpeg-static", "ffprobe-static"],
  banner: {
    js: 'import { createRequire as __clipperCreateRequire } from "node:module"; const require = __clipperCreateRequire(import.meta.url);',
  },
  logLevel: "info",
});

fs.copyFileSync(path.join(dir, "src/preload.cjs"), path.join(outDir, "preload.cjs"));

const rendererSrc = path.join(dir, "../client/dist");
if (fs.existsSync(path.join(rendererSrc, "index.html"))) {
  const rendererDest = path.join(outDir, "renderer");
  fs.rmSync(rendererDest, { recursive: true, force: true });
  fs.cpSync(rendererSrc, rendererDest, { recursive: true });
}

const ffmpegSrc = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
if (typeof ffmpegSrc !== "string" || !ffmpegSrc) {
  throw new Error("ffmpeg-static path missing");
}
const ffprobeSrc = ffprobeStatic?.path;
if (typeof ffprobeSrc !== "string" || !ffprobeSrc) {
  throw new Error("ffprobe-static path missing");
}

const ext = process.platform === "win32" ? ".exe" : "";
for (const stale of fs.readdirSync(resourcesDir)) {
  fs.rmSync(path.join(resourcesDir, stale), { force: true });
}
const ffmpegDest = path.join(resourcesDir, `ffmpeg${ext}`);
const ffprobeDest = path.join(resourcesDir, `ffprobe${ext}`);
fs.copyFileSync(ffmpegSrc, ffmpegDest);
fs.copyFileSync(ffprobeSrc, ffprobeDest);
if (process.platform !== "win32") {
  fs.chmodSync(ffmpegDest, 0o755);
  fs.chmodSync(ffprobeDest, 0o755);
}
