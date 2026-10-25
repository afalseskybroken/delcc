import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 4000, // bundled Monaco is ~3 MB, loaded lazily on first problem open
    target: "es2021",
  },
});
