import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(dir, "dist");
fs.mkdirSync(outDir, { recursive: true });

await esbuild.build({
  absWorkingDir: dir,
  entryPoints: ["src/main.ts"],
  outfile: path.join(outDir, "main.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["electron", "@clipper/server"],
  logLevel: "info",
});

fs.copyFileSync(path.join(dir, "src/preload.cjs"), path.join(outDir, "preload.cjs"));
