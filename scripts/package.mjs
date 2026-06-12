import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const zipPath = resolve(root, "package.zip");

if (existsSync(zipPath)) {
  rmSync(zipPath);
}

const result = spawnSync("zip", ["-r", zipPath, "."], {
  cwd: resolve(root, "dist"),
  stdio: "inherit"
});

if (result.status !== 0) {
  throw new Error("package.zip 打包失败，请确认系统中可用 zip 命令");
}

