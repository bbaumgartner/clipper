import path from "node:path";
import { startServer } from "./index.js";

const dataDir = path.resolve(
  process.env.CLIPPER_DATA_DIR ?? path.join(process.cwd(), ".clipper-dev-data"),
);
const port = Number(process.env.CLIPPER_PORT ?? 47281);

const { port: bound } = await startServer({
  host: "127.0.0.1",
  port,
  dataDir,
});
console.log(`clipper server http://127.0.0.1:${bound}`);
