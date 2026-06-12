import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: resolve(import.meta.dirname, "dist"),
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, "src/plugin/index.ts"),
      formats: ["cjs"],
      fileName: () => "index.js"
    },
    rollupOptions: {
      external: ["siyuan"],
      output: {
        globals: {
          siyuan: "siyuan"
        }
      }
    }
  }
});
