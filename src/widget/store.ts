import { readWorkspaceFile, writeWorkspaceFile } from "./api";

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
  /** 待办是否已完成；仅 isTodo 为 true 时有效 */
  done?: boolean;
}

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
