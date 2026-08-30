import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:47281",
        changeOrigin: true,
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
