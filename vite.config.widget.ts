import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve(import.meta.dirname, "src/widget"),
  base: "./",
  build: {
    outDir: resolve(import.meta.dirname, "dist/widget"),
    emptyOutDir: true
  }
});
