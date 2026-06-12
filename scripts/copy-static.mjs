import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dist = resolve(root, "dist");

mkdirSync(dist, { recursive: true });

for (const file of ["plugin.json", "README.md", "README_zh_CN.md", "icon.png", "preview.png", "LICENSE"]) {
  const source = resolve(root, file);
  if (existsSync(source)) {
    copyFileSync(source, resolve(dist, file));
  }
}
