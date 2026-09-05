import { app, BrowserWindow, dialog, ipcMain } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
app.commandLine.appendSwitch("enable-features", "PlatformHEVCDecoderSupport");
const here = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.CLIPPER_DEV === "1" || !app.isPackaged;

function packagedBin(name: string): string {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  return path.join(process.resourcesPath, file);
}

if (app.isPackaged) {
  process.env.CLIPPER_FFMPEG = packagedBin("ffmpeg");
  process.env.CLIPPER_FFPROBE = packagedBin("ffprobe");
}
let apiPort = Number(process.env.CLIPPER_PORT ?? 47281);
let mainWindow: BrowserWindow | null = null;

function fail(err: unknown): void {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(message);
  if (app.isReady()) {
    dialog.showErrorBox("Clipper failed to start", message);
  }
}

process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

ipcMain.on("clipper:get-port", (event) => {
  event.returnValue = apiPort;
});

ipcMain.handle("clipper:select-files", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "Video",
        extensions: ["mp4", "mov", "mkv", "webm", "m4v", "avi"],
      },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("clipper:select-save", async () => {
  const result = await dialog.showSaveDialog({
    defaultPath: "clipper-export.mp4",
    filters: [{ name: "MP4", extensions: ["mp4"] }],
  });
  return result.canceled ? null : result.filePath;
});

async function createWindow(): Promise<void> {
  const preload = path.join(here, "preload.cjs");
  if (!fs.existsSync(preload)) {
    throw new Error(`preload missing: ${preload}`);
  }
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: "#0e0e0e",
    title: "Clipper",
    show: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (dev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    const index = path.join(here, "renderer/index.html");
    await mainWindow.loadFile(index);
  }
}

app
  .whenReady()
  .then(async () => {
    if (!dev) {
      const { startServer } = await import("@clipper/server");
      const { port } = await startServer({
        host: "127.0.0.1",
        port: 0,
        dataDir: app.getPath("userData"),
      });
      apiPort = port;
    }
    await createWindow();
  })
  .catch(fail);

app.on("window-all-closed", () => {
  app.quit();
});
