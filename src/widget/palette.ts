import { readWorkspaceFile, writeWorkspaceFile } from "./api";

/** Notion 风格的低饱和默认取色板，保持事件色块可读但不过亮 */
export const DEFAULT_PALETTE = [
  "#548164", // 绿
  "#487ca5", // 蓝
  "#c4554d", // 红
  "#c29343", // 黄
  "#8a67ab" // 紫
];

const FILE = "/data/storage/schedule-block/palette.json";
const HEX_RE = /^#[0-9a-f]{6}$/i;

/** 模块级单例：popover 与 main 共享同一份取色板顺序 */
let palette: string[] = [...DEFAULT_PALETTE];
let channel: BroadcastChannel | null = null;
let persistLock: Promise<void> = Promise.resolve();
let remoteHandler: (() => void) | null = null;

try {
  channel = new BroadcastChannel("schedule-block-palette");
  channel.onmessage = async () => {
    try {
      await loadPalette();
      remoteHandler?.();
    } catch {
      // 取色板是辅助配置，远端同步失败不影响日程显示
    }
  };
} catch {
  channel = null;
}

export function getPalette(): string[] {
  return palette;
}

export function defaultColor(): string {
  return palette[0] || DEFAULT_PALETTE[0];
}

export function isValidColor(value: string): boolean {
  return HEX_RE.test(value);
}

/** 校验、去重、统一小写；非法或为空时回退默认取色板 */
function normalize(colors: unknown): string[] {
  if (!Array.isArray(colors)) {
    return [...DEFAULT_PALETTE];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of colors) {
    if (typeof c === "string" && HEX_RE.test(c)) {
      const lower = c.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        out.push(lower);
      }
    }
  }
  return out.length ? out : [...DEFAULT_PALETTE];
}

export function onPaletteRemoteChange(fn: () => void): void {
  remoteHandler = fn;
}

export async function loadPalette(): Promise<void> {
  const text = await readWorkspaceFile(FILE);
  if (!text) {
    palette = [...DEFAULT_PALETTE];
    return;
  }
  try {
    const parsed = JSON.parse(text) as { colors?: unknown };
    palette = normalize(parsed.colors);
  } catch {
    palette = [...DEFAULT_PALETTE];
  }
}

/** 乐观更新：先改内存中的顺序再落盘，与事件/天气 store 行为一致 */
export async function savePalette(colors: string[]): Promise<void> {
  palette = normalize(colors);
  const run = async () => {
    const payload = {
      version: 1,
      updated: new Date().toISOString(),
      colors: palette
    };
    await writeWorkspaceFile(FILE, JSON.stringify(payload, null, 2));
  };
  const task = persistLock.then(run, run);
  persistLock = task.then(
    () => undefined,
    () => undefined
  );
  await task;
  channel?.postMessage("changed");
}
