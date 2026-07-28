import { readWorkspaceFile, writeWorkspaceFile } from "./api";
import { addDaysStr } from "./util";
import type { RepeatRule } from "./repeat";

export interface CalEvent {
  id: string;
  title: string;
  /** 定时日程为 "YYYY-MM-DDTHH:mm"，全天日程为 "YYYY-MM-DD" */
  start: string;
  /** 全天日程的 end 为排他日期（FullCalendar 约定） */
  end: string;
  allDay: boolean;
  color: string;
  note: string;
  /** 所属文档的 root_id；空字符串表示未分配（旧数据兼容） */
  docId: string;
  /** 是否作为待办事项显示；缺省为普通日程（旧数据兼容） */
  isTodo?: boolean;
  /** 待办是否已完成；仅 isTodo 为 true 时有效（重复日程改用 doneDates 逐次记录） */
  done?: boolean;
  /** 重复规则；没有该字段就是普通单条日程 */
  repeat?: RepeatRule;
  /** 已从系列里摘出去的日期：被单独修改（另存为独立日程）或单独删除的那几次 */
  exdates?: string[];
  /** 重复待办里已完成的那几次 */
  doneDates?: string[];
}

/** 改动/删除重复日程时的作用范围，与 Google / Apple 日历一致 */
export type RepeatScope = "this" | "following" | "all";

const FILE = "/data/storage/schedule-block/events.json";
const BAK_FILE = "/data/storage/schedule-block/events.json.bak";
const LEGACY_FILE = "/data/storage/calendar-block/events.json";
const UNDO_LIMIT = 50;

/** 全部日程块共享同一份日程数据；BroadcastChannel 让同时打开的多个日程块即时同步 */
export class EventStore {
  events: CalEvent[] = [];
  /** 当前日程块所属文档的 root_id */
  docId: string = "";
  onRemoteChange?: () => void;
  /** 数据未成功加载（文件损坏或读取失败）时禁止一切写入，防止覆盖原有数据 */
  loadFailed = false;
  private channel: BroadcastChannel | null = null;
  private undoStack: CalEvent[][] = [];
  /** 最近一次成功读到或写出的文件内容，保存前先写入 .bak 作为回退 */
  private lastGoodText: string | null = null;
  private persistLock: Promise<void> = Promise.resolve();
  private autoRefreshTimer: number | null = null;

  constructor() {
    try {
      this.channel = new BroadcastChannel("schedule-block");
      this.channel.onmessage = async () => {
        try {
          await this.load();
        } catch {
          // 远端同步失败时保留 loadFailed 状态，下次写入会被拦截
        }
        // 数据已被其他日程块改写，本地撤销栈作废
        this.undoStack = [];
        this.onRemoteChange?.();
      };
    } catch {
      this.channel = null;
    }
  }

  async load(): Promise<void> {
    let text: string | null;
    try {
      text = (await readWorkspaceFile(FILE)) || (await readWorkspaceFile(LEGACY_FILE));
    } catch (err) {
      this.loadFailed = true;
      throw err;
    }
    if (!text) {
      if (this.events.length > 0) {
        this.loadFailed = true;
        throw new Error("日程数据读取失败（返回空），已禁止保存以防覆盖");
      }
      this.events = [];
      this.lastGoodText = null;
      this.loadFailed = false;
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || !Array.isArray(parsed.events)) {
        throw new Error("缺少 events 字段");
      }
      this.events = parsed.events;
      // 兼容旧数据：确保所有事件都有 docId 字段
      for (const e of this.events) {
        if (e.docId === undefined || e.docId === null) {
          e.docId = "";
        }
        if (e.isTodo === undefined || e.isTodo === null) {
          e.isTodo = false;
        }
        if (e.done === undefined || e.done === null) {
          e.done = false;
        }
      }
      this.lastGoodText = text;
      this.loadFailed = false;
    } catch {
      this.loadFailed = true;
      throw new Error("日程数据文件解析失败，已禁止保存以防覆盖（可检查 data/storage/schedule-block/events.json）");
    }
  }

  get(id: string): CalEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** 全局共享日历：所有日程块（面板与任意文档内的嵌入块）都显示全部事件，不按文档隔离。 */
  visibleEvents(): CalEvent[] {
    return this.events;
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** 回退到上一次操作前的状态；无可撤销时返回 false */
  async undo(): Promise<boolean> {
    this.ensureWritable();
    const prev = this.undoStack.pop();
    if (!prev) {
      return false;
    }
    this.events = prev;
    await this.persist();
    return true;
  }

  async add(event: CalEvent): Promise<void> {
    this.ensureWritable();
    this.snapshot();
    this.events.push(event);
    await this.persist();
  }

  /**
   * 按范围改动重复日程。
   * - all：直接改主事件，整串跟着变
   * - this：把这一次从系列里摘出去（exdates），另存成一条独立日程
   * - following：把原规则截止到前一天，再从这一次起另开一条带新规则的日程
   * 三种情况都只占一次快照，撤销一步即可回到改动前。
   */
  async updateOccurrence(
    eventId: string,
    date: string,
    scope: RepeatScope,
    patch: Partial<CalEvent>,
    newId: () => string
  ): Promise<void> {
    this.ensureWritable();
    const event = this.get(eventId);
    if (!event) {
      return;
    }
    this.snapshot();
    if (scope === "all" || !event.repeat || !date) {
      Object.assign(event, patch);
      await this.persist();
      return;
    }
    if (scope === "this") {
      event.exdates = [...(event.exdates || []), date].sort();
      this.events.push({
        ...event,
        id: newId(),
        repeat: undefined,
        exdates: undefined,
        doneDates: undefined,
        done: (event.doneDates || []).includes(date),
        ...patch
      });
      await this.persist();
      return;
    }
    // following：原系列在这一次之前结束
    const previousDay = addDaysStr(date, -1);
    const startDate = event.start.split("T")[0];
    const detached: CalEvent = {
      ...event,
      id: newId(),
      exdates: (event.exdates || []).filter((d) => d >= date),
      doneDates: (event.doneDates || []).filter((d) => d >= date),
      done: false,
      ...patch
    };
    if (previousDay < startDate) {
      // 从第一次就开始改，等同于整串修改
      this.events = this.events.filter((e) => e.id !== event.id);
    } else {
      event.repeat = { ...event.repeat, count: undefined, until: previousDay };
      event.exdates = (event.exdates || []).filter((d) => d < date);
      event.doneDates = (event.doneDates || []).filter((d) => d < date);
    }
    this.events.push(detached);
    await this.persist();
  }

  /** 按范围删除重复日程的某一次 */
  async removeOccurrence(eventId: string, date: string, scope: RepeatScope): Promise<void> {
    this.ensureWritable();
    const event = this.get(eventId);
    if (!event) {
      return;
    }
    this.snapshot();
    if (scope === "all" || !event.repeat || !date) {
      this.events = this.events.filter((e) => e.id !== eventId);
      await this.persist();
      return;
    }
    if (scope === "this") {
      event.exdates = [...(event.exdates || []), date].sort();
      await this.persist();
      return;
    }
    const previousDay = addDaysStr(date, -1);
    if (previousDay < event.start.split("T")[0]) {
      this.events = this.events.filter((e) => e.id !== eventId);
    } else {
      event.repeat = { ...event.repeat, count: undefined, until: previousDay };
      event.exdates = (event.exdates || []).filter((d) => d < date);
      event.doneDates = (event.doneDates || []).filter((d) => d < date);
    }
    await this.persist();
  }

  /** 勾选/取消勾选某一次待办：重复日程逐次记录，普通日程改 done */
  async toggleDone(eventId: string, date: string): Promise<void> {
    this.ensureWritable();
    const event = this.get(eventId);
    if (!event || !event.isTodo) {
      return;
    }
    this.snapshot();
    if (!event.repeat || !date) {
      event.done = !event.done;
    } else {
      const dates = new Set(event.doneDates || []);
      if (dates.has(date)) {
        dates.delete(date);
      } else {
        dates.add(date);
      }
      event.doneDates = Array.from(dates).sort();
    }
    await this.persist();
  }

  async update(id: string, patch: Partial<CalEvent>): Promise<void> {
    this.ensureWritable();
    const event = this.get(id);
    if (!event) {
      return;
    }
    this.snapshot();
    Object.assign(event, patch);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.ensureWritable();
    if (!this.get(id)) {
      return;
    }
    this.snapshot();
    this.events = this.events.filter((e) => e.id !== id);
    await this.persist();
  }

  private ensureWritable(): void {
    if (this.loadFailed) {
      throw new Error("日程数据未正确加载，已禁止修改以防覆盖原有数据");
    }
  }

  private snapshot(): void {
    this.undoStack.push(this.events.map((e) => ({ ...e })));
    if (this.undoStack.length > UNDO_LIMIT) {
      this.undoStack.shift();
    }
  }

  startAutoRefresh(intervalMs: number = 30000): void {
    this.stopAutoRefresh();
    this.autoRefreshTimer = window.setInterval(async () => {
      if (this.loadFailed) {
        try {
          await this.load();
          this.onRemoteChange?.();
        } catch {
          // 自愈失败时保留 loadFailed 状态，下次间隔再试
        }
      }
    }, intervalMs);
  }

  stopAutoRefresh(): void {
    if (this.autoRefreshTimer !== null) {
      window.clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
  }

  private async persist(): Promise<void> {
    this.ensureWritable();
    const run = async () => {
      const payload = {
        version: 2,
        updated: new Date().toISOString(),
        events: this.events
      };
      const text = JSON.stringify(payload, null, 2);
      if (this.lastGoodText && this.lastGoodText !== text) {
        try {
          await writeWorkspaceFile(BAK_FILE, this.lastGoodText);
        } catch {
          // 备份失败不阻塞正常保存
        }
      }
      await writeWorkspaceFile(FILE, text);
      this.lastGoodText = text;
    };
    // 串行化写入；无论前一次成功或失败都继续执行本次，错误只抛给各自的调用方
    const task = this.persistLock.then(run, run);
    this.persistLock = task.then(
      () => undefined,
      () => undefined
    );
    await task;
    this.channel?.postMessage("changed");
  }
}
