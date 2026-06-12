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
}

const FILE = "/data/storage/schedule-block/events.json";
const LEGACY_FILE = "/data/storage/calendar-block/events.json";

/** 全部日程块共享同一份日程数据；BroadcastChannel 让同时打开的多个日程块即时同步 */
export class EventStore {
  events: CalEvent[] = [];
  /** 当前日程块所属文档的 root_id */
  docId: string = "";
  onRemoteChange?: () => void;
  private channel: BroadcastChannel | null = null;

  constructor() {
    try {
      this.channel = new BroadcastChannel("schedule-block");
      this.channel.onmessage = async () => {
        await this.load();
        this.onRemoteChange?.();
      };
    } catch {
      this.channel = null;
    }
  }

  async load(): Promise<void> {
    const text = (await readWorkspaceFile(FILE)) || (await readWorkspaceFile(LEGACY_FILE));
    if (!text) {
      this.events = [];
      return;
    }
    try {
      const parsed = JSON.parse(text);
      this.events = Array.isArray(parsed?.events) ? parsed.events : [];
      // 兼容旧数据：确保所有事件都有 docId 字段
      for (const e of this.events) {
        if (e.docId === undefined || e.docId === null) {
          e.docId = "";
        }
      }
    } catch {
      this.events = [];
    }
  }

  get(id: string): CalEvent | undefined {
    return this.events.find((e) => e.id === id);
  }

  /** 正常嵌入文档时仅显示所属文档日程；独立打开且无文档 ID 时不做过滤，便于调试。 */
  visibleEvents(): CalEvent[] {
    if (!this.docId) {
      return this.events;
    }
    return this.events.filter((e) => e.docId === this.docId);
  }

  async add(event: CalEvent): Promise<void> {
    // 自动补上当前文档 docId
    if (!event.docId && this.docId) {
      event.docId = this.docId;
    }
    this.events.push(event);
    await this.persist();
  }

  async update(id: string, patch: Partial<CalEvent>): Promise<void> {
    const event = this.get(id);
    if (!event) {
      return;
    }
    // 若旧事件没有 docId，编辑时自动分配当前文档
    if (!event.docId && this.docId) {
      event.docId = this.docId;
    }
    Object.assign(event, patch);
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    this.events = this.events.filter((e) => e.id !== id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    const payload = {
      version: 2,
      updated: new Date().toISOString(),
      events: this.events
    };
    await writeWorkspaceFile(FILE, JSON.stringify(payload, null, 2));
    this.channel?.postMessage("changed");
  }
}
