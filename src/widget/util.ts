import { fmtDate, isoWeekStart, parseDateFromTitle } from "../shared/date";

export { fmtDate, isoWeekStart, parseDateFromTitle };

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function fmtTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDateTime(d: Date): string {
  return `${fmtDate(d)}T${fmtTime(d)}`;
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDaysStr(dateStr: string, days: number): string {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + days);
  return fmtDate(d);
}

export function isValidDateStr(s: string): boolean {
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const d = new Date(year, month - 1, day);
  return d.getFullYear() === year && d.getMonth() === month - 1 && d.getDate() === day;
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60 * 1000);
}

/** b - a 的天数差（基于 YYYY-MM-DD 字符串） */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86400000);
}

/** "HH:mm" → 当天分钟数；非法格式返回 null */
export function parseTimeMinutes(t: string): number | null {
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) {
    return null;
  }
  const total = Number(m[1]) * 60 + Number(m[2]);
  return total >= 0 && total < 24 * 60 ? total : null;
}

/** 分钟数 → "HH:mm"，超出当天时收敛到 23:59 */
export function minutesToTime(total: number): string {
  const clamped = Math.min(Math.max(total, 0), 23 * 60 + 59);
  return `${pad2(Math.floor(clamped / 60))}:${pad2(clamped % 60)}`;
}

const LUNAR_DAYS = [
  "",
  "初一",
  "初二",
  "初三",
  "初四",
  "初五",
  "初六",
  "初七",
  "初八",
  "初九",
  "初十",
  "十一",
  "十二",
  "十三",
  "十四",
  "十五",
  "十六",
  "十七",
  "十八",
  "十九",
  "二十",
  "廿一",
  "廿二",
  "廿三",
  "廿四",
  "廿五",
  "廿六",
  "廿七",
  "廿八",
  "廿九",
  "三十"
];

export function lunarDateLabel(d: Date): string {
  try {
    const raw = new Intl.DateTimeFormat("zh-CN-u-ca-chinese", {
      month: "long",
      day: "numeric"
    }).format(d);
    return raw.replace(/(\d{1,2})日$/, (_match, day) => `${LUNAR_DAYS[Number(day)] || `${day}日`}`);
  } catch {
    return "";
  }
}



export function getIsoWeek(d: Date): string {
  const normalized = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = normalized.getUTCDay() || 7;
  normalized.setUTCDate(normalized.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(normalized.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((normalized.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${normalized.getUTCFullYear()}-W${pad2(week)}`;
}

export function newEventId(): string {
  return `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** 根据背景色亮度决定文字用深色还是白色 */
export function textColorFor(hex: string): string {
  const m = hex.replace("#", "");
  if (m.length !== 6) {
    return "#fff";
  }
  const r = parseInt(m.slice(0, 2), 16) / 255;
  const g = parseInt(m.slice(2, 4), 16) / 255;
  const b = parseInt(m.slice(4, 6), 16) / 255;
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#1f2329" : "#fff";
}
