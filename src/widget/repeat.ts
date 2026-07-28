import { CalEvent } from "./store";
import { addDaysStr, diffDays, fmtDate, isValidDateStr, parseDate } from "./util";

/**
 * 重复规则与实例展开。
 * 日程只存一条规则，视图按需把它展开成一个个实例（occurrence），
 * 与 Google / Apple 日历一致：改规则整串跟着变，单独改动的那几次从系列里摘出去。
 */

export type RepeatFreq = "daily" | "weekday" | "weekly" | "biweekly" | "monthly" | "yearly";

export interface RepeatRule {
  freq: RepeatFreq;
  /** 含首次在内的总次数；与 until 互斥，两者皆无表示永不结束 */
  count?: number;
  /** 结束日期（含当天） */
  until?: string;
}

export const REPEAT_FREQS: RepeatFreq[] = ["daily", "weekday", "weekly", "biweekly", "monthly", "yearly"];

/** 频率文案取 Apple 日历的简洁档位，不把具体日期塞进选项 */
export const REPEAT_FREQ_LABELS: Record<RepeatFreq, string> = {
  daily: "每天",
  weekday: "每个工作日",
  weekly: "每周",
  biweekly: "每两周",
  monthly: "每月",
  yearly: "每年"
};

/** 单次展开的实例数上限，避免"永不结束"在极端范围里跑飞 */
const MAX_OCCURRENCES = 400;
/** 迭代候选期数的上限（含被跳过的无效日期，如 2 月 30 日） */
const MAX_STEPS = 4000;

export interface Occurrence {
  /** 所属日程（系列主事件或普通单条日程） */
  event: CalEvent;
  /** 该实例的起始日期（YYYY-MM-DD），同时作为实例标识的一部分 */
  date: string;
  /** 存储口径的起止（普通日程即事件本身的 start/end） */
  start: string;
  end: string;
  /** 待办完成状态：重复日程逐实例记录 */
  done: boolean;
  /** 是否来自重复规则 */
  repeating: boolean;
}

export function hasRepeat(event: CalEvent): boolean {
  return Boolean(event.repeat && REPEAT_FREQS.includes(event.repeat.freq));
}

/** 实例标识：普通日程就是事件 id，重复实例带上日期 */
export function instanceId(eventId: string, date: string, repeating: boolean): string {
  return repeating ? `${eventId}@${date}` : eventId;
}

export function parseInstanceId(id: string): { eventId: string; date: string } {
  const at = id.lastIndexOf("@");
  if (at < 0) {
    return { eventId: id, date: "" };
  }
  return { eventId: id.slice(0, at), date: id.slice(at + 1) };
}

/** 事件起始日（日期部分） */
export function eventStartDate(event: CalEvent): string {
  return event.start.split("T")[0];
}

/** 把存储口径的时间戳整体后移若干天 */
export function shiftStamp(stamp: string, days: number): string {
  const [datePart, timePart] = stamp.split("T");
  const shifted = addDaysStr(datePart, days);
  return timePart ? `${shifted}T${timePart}` : shifted;
}

/** 规则的下一个候选日期；返回 null 表示这一期无效（如该月没有 31 日），调用方跳过继续 */
function candidateDate(anchor: Date, freq: RepeatFreq, step: number): Date | null {
  const day = anchor.getDate();
  if (freq === "daily" || freq === "weekday") {
    return new Date(anchor.getFullYear(), anchor.getMonth(), day + step);
  }
  if (freq === "weekly") {
    return new Date(anchor.getFullYear(), anchor.getMonth(), day + step * 7);
  }
  if (freq === "biweekly") {
    return new Date(anchor.getFullYear(), anchor.getMonth(), day + step * 14);
  }
  if (freq === "monthly") {
    const d = new Date(anchor.getFullYear(), anchor.getMonth() + step, day);
    return d.getDate() === day ? d : null;
  }
  const d = new Date(anchor.getFullYear() + step, anchor.getMonth(), day);
  return d.getDate() === day ? d : null;
}

/**
 * 规则展开出的全部实例日期（含首次），按时间升序。
 * 工作日频率只保留周一至周五，但首次按用户选定的那天照排。
 */
export function occurrenceDates(event: CalEvent, limitDate?: string): string[] {
  const rule = event.repeat;
  const first = eventStartDate(event);
  if (!rule || !isValidDateStr(first)) {
    return [first];
  }
  const anchor = parseDate(first);
  const until = rule.until && isValidDateStr(rule.until) ? rule.until : "";
  const total = rule.count && rule.count > 0 ? Math.min(Math.round(rule.count), MAX_OCCURRENCES) : 0;
  const maxCount = total || MAX_OCCURRENCES;
  const dates: string[] = [first];
  for (let step = 1; dates.length < maxCount && step <= MAX_STEPS; step += 1) {
    const target = candidateDate(anchor, rule.freq, step);
    if (!target) {
      continue;
    }
    if (rule.freq === "weekday") {
      const dow = target.getDay();
      if (dow === 0 || dow === 6) {
        continue;
      }
    }
    const str = fmtDate(target);
    if (until && str > until) {
      break;
    }
    dates.push(str);
    // 视图只需要展开到 limitDate 为止
    if (limitDate && str > limitDate) {
      break;
    }
  }
  return dates;
}

/** 系列的最后一次日期；永不结束时返回空串 */
export function lastOccurrenceDate(event: CalEvent): string {
  const rule = event.repeat;
  if (!rule) {
    return eventStartDate(event);
  }
  if (!rule.count && !rule.until) {
    return "";
  }
  const dates = occurrenceDates(event);
  return dates[dates.length - 1] || eventStartDate(event);
}

/** 系列的实例总数；永不结束时返回 0 */
export function occurrenceCount(event: CalEvent): number {
  const rule = event.repeat;
  if (!rule) {
    return 1;
  }
  if (!rule.count && !rule.until) {
    return 0;
  }
  return occurrenceDates(event).filter((d) => !(event.exdates || []).includes(d)).length;
}

/**
 * 展开某个日程在 [rangeStart, rangeEnd) 内的实例。
 * 普通日程原样返回；重复日程按规则展开，并跳过被单独摘出去的日期（exdates）。
 */
export function occurrencesInRange(event: CalEvent, rangeStart: string, rangeEnd: string): Occurrence[] {
  const spanDays = Math.max(diffDays(eventStartDate(event), event.end.split("T")[0]), 0);
  if (!hasRepeat(event)) {
    const start = eventStartDate(event);
    // 跨天日程只要与范围有交集就要渲染
    if (addDaysStr(start, spanDays) < rangeStart || start >= rangeEnd) {
      return [];
    }
    return [{
      event,
      date: start,
      start: event.start,
      end: event.end,
      done: Boolean(event.done),
      repeating: false
    }];
  }
  const exdates = new Set(event.exdates || []);
  const doneDates = new Set(event.doneDates || []);
  const first = eventStartDate(event);
  const out: Occurrence[] = [];
  for (const date of occurrenceDates(event, rangeEnd)) {
    if (date >= rangeEnd) {
      break;
    }
    if (addDaysStr(date, spanDays) < rangeStart || exdates.has(date)) {
      continue;
    }
    const offset = diffDays(first, date);
    out.push({
      event,
      date,
      start: shiftStamp(event.start, offset),
      end: shiftStamp(event.end, offset),
      done: doneDates.has(date),
      repeating: true
    });
  }
  return out;
}

/** 规则的可读描述，用于编辑弹窗提示 */
export function describeRepeat(event: CalEvent): string {
  const rule = event.repeat;
  if (!rule) {
    return "";
  }
  const freq = REPEAT_FREQ_LABELS[rule.freq] || "重复";
  if (rule.count && rule.count > 0) {
    return `${freq} · 共 ${rule.count} 次`;
  }
  if (rule.until) {
    return `${freq} · 至 ${rule.until}`;
  }
  return `${freq} · 永不结束`;
}
