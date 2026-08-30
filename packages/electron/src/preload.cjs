const { contextBridge, ipcRenderer } = require("electron");

const port = ipcRenderer.sendSync("clipper:get-port");

contextBridge.exposeInMainWorld("clipper", {
  apiBase: `http://127.0.0.1:${port}`,
  selectFiles: () => ipcRenderer.invoke("clipper:select-files"),
  selectSavePath: () => ipcRenderer.invoke("clipper:select-save"),
});
