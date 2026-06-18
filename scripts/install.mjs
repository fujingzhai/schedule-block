import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = process.env.SIYUAN_DATA_DIR || resolve(homedir(), "siyuan/data");
const backupRoot = resolve(homedir(), "AI-Space/.tmp/schedule-block/install-backups");
const target = resolve(dataDir, "plugins/schedule-block");

mkdirSync(backupRoot, { recursive: true });
mkdirSync(resolve(target, ".."), { recursive: true });

if (existsSync(target)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  renameSync(target, resolve(backupRoot, `schedule-block-${stamp}`));
}

cpSync(resolve(root, "dist"), target, { recursive: true });
console.log(`已安装 schedule-block 到 ${target}`);
