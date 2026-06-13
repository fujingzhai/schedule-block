import { readWorkspaceFile, writeWorkspaceFile } from "./api";

/** 谷歌日历风格的默认取色板（去掉与主题重复的石墨灰 #616161） */
export const DEFAULT_PALETTE = [
  "#d50000", // 番茄红
  "#e67c73", // 火鹤红
  "#f4511e", // 橘子橙
  "#f6bf26", // 香蕉黄
  "#33b679", // 鼠尾草绿
  "#0b8043", // 罗勒绿
  "#039be5", // 孔雀蓝
  "#3f51b5", // 蓝莓
  "#7986cb", // 薰衣草
  "#8e24aa" // 葡萄紫
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
