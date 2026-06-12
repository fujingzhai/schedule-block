import { Calendar, DateSelectArg, EventApi, EventClickArg, EventDropArg, EventInput } from "@fullcalendar/core";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin, { DateClickArg, EventResizeDoneArg } from "@fullcalendar/interaction";
import { getBlockAttrs, setBlockAttrs, getDocTitle, getRootId } from "./api";
import { CalEvent, EventStore } from "./store";
import { initThemeBridge } from "./theme";
import {
  closePopover,
  DEFAULT_COLOR,
  openPopover,
  PopoverValues,
  valuesToRange
} from "./popover";
import { addMinutes, fmtDate, fmtDateTime, fmtTime, addDaysStr, newEventId, textColorFor, parseDateFromTitle, getIsoWeek, parseDate, isoWeekStart, isValidDateStr, lunarDateLabel } from "./util";
import "./widget.css";

type ViewKey = "day" | "week";
const VIEW_MAP: Record<ViewKey, string> = {
  day: "timeGridDay",
  week: "timeGridWeek"
};
const VIEW_KEY: Record<string, ViewKey> = {
  timeGridDay: "day",
  timeGridWeek: "week"
};

const VIEW_ATTR = "custom-calendar-view";
const DATE_ATTR = "custom-calendar-date";
const DURATION_ATTR = "custom-calendar-default-duration";
const DEFAULT_HEIGHT = "1030px";
const DEFAULT_DURATION_MINUTES = 60;
const DURATION_OPTIONS = [15, 30, 45, 60];
const LAST_COLOR_KEY = "schedule-block-last-color";

const store = new EventStore();
let calendar: Calendar;
let blockId = "";
let docId = "";
let anchorDate = "";
let persistedViewKey: ViewKey | "" = "";
let defaultDurationMinutes = DEFAULT_DURATION_MINUTES;
let suppressUntil = 0;
let anchorEditor: { el: HTMLElement; dispose(): void } | null = null;

function lastColor(): string {
  try {
    return localStorage.getItem(LAST_COLOR_KEY) || DEFAULT_COLOR;
  } catch {
    return DEFAULT_COLOR;
  }
}

function rememberColor(color: string): void {
  try {
    localStorage.setItem(LAST_COLOR_KEY, color);
  } catch {
    // 忽略
  }
}

function parseDurationMinutes(value: string | null | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_DURATION_MINUTES;
  }
  return Math.min(Math.max(Math.round(parsed), 5), 480);
}

function durationLabel(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} 分钟`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60} 小时`;
  }
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`;
}

function durationToFullCalendar(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function applyEventColor(event: EventApi, color: string): void {
  event.setProp("backgroundColor", color);
  event.setProp("borderColor", "transparent");
  event.setProp("textColor", textColorFor(color));
}

function applyValuesToEvent(event: EventApi, values: PopoverValues): void {
  const range = valuesToRange(values);
  event.setProp("title", values.title || "（无标题）");
  applyEventColor(event, values.color);
  event.setDates(range.start, range.end, { allDay: range.allDay });
}

function toFC(event: CalEvent): EventInput {
  return {
    id: event.id,
    title: event.title,
    start: event.start,
    end: event.end,
    allDay: event.allDay,
    backgroundColor: event.color,
    borderColor: "transparent",
    textColor: textColorFor(event.color)
  };
}

function eventToValues(event: CalEvent): PopoverValues {
  if (event.allDay) {
    const lastDay = addDaysStr(event.end, -1);
    return {
      title: event.title,
      allDay: true,
      startDate: event.start,
      startTime: "09:00",
      endDate: lastDay >= event.start ? lastDay : event.start,
      endTime: "10:00",
      color: event.color,
      note: event.note
    };
  }
  const [sd, st] = event.start.split("T");
  const [ed, et] = event.end.split("T");
  return {
    title: event.title,
    allDay: false,
    startDate: sd,
    startTime: st || "09:00",
    endDate: ed || sd,
    endTime: et || "10:00",
    color: event.color,
    note: event.note
  };
}

function serializeRange(event: { start: Date | null; end: Date | null; allDay: boolean }): { start: string; end: string } {
  const start = event.start || new Date();
  if (event.allDay) {
    const end = event.end || addMinutes(start, 24 * 60);
    return { start: fmtDate(start), end: fmtDate(end) };
  }
  const end = event.end || addMinutes(start, 60);
  return { start: fmtDateTime(start), end: fmtDateTime(end) };
}

function refresh(): void {
  calendar.refetchEvents();
}

/* ---------- 交互回调 ---------- */

function onSelect(info: DateSelectArg): void {
  if (Date.now() < suppressUntil) {
    calendar.unselect();
    return;
  }
  const allDay = info.allDay;
  const values: PopoverValues = {
    title: "",
    allDay,
    startDate: fmtDate(info.start),
    startTime: allDay ? "09:00" : fmtTime(info.start),
    endDate: allDay ? addDaysStr(fmtDate(info.end), -1) : fmtDate(info.end),
    endTime: allDay ? "10:00" : fmtTime(info.end),
    color: lastColor(),
    note: ""
  };
  calendar.unselect();
  const draft = calendar.addEvent({
    id: `draft-${Date.now().toString(36)}`,
    title: "（无标题）",
    start: info.start,
    end: info.end,
    allDay,
    backgroundColor: values.color,
    borderColor: "transparent",
    textColor: textColorFor(values.color),
    editable: false,
    classNames: ["cb-event-draft"]
  });
  let draftSavedId = "";
  let draftInteracted = false;
  let latestDraftValues = values;
  let draftSaveTimer = 0;
  const persistDraft = async (v: PopoverValues, close = false) => {
    draftInteracted = true;
    latestDraftValues = v;
    rememberColor(v.color);
    const range = valuesToRange(v);
    if (!draftSavedId) {
      draftSavedId = newEventId();
      await store.add({
        id: draftSavedId,
        title: v.title,
        start: range.start,
        end: range.end,
        allDay: range.allDay,
        color: v.color,
        note: v.note,
        docId: docId
      });
    } else {
      await store.update(draftSavedId, {
        title: v.title,
        start: range.start,
        end: range.end,
        allDay: range.allDay,
        color: v.color,
        note: v.note
      });
    }
    if (close) {
      draft?.remove();
      refresh();
    }
  };
  const queueDraftSave = (v: PopoverValues) => {
    draftInteracted = true;
    latestDraftValues = v;
    if (draft) {
      applyValuesToEvent(draft, v);
    }
    window.clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(() => {
      persistDraft(latestDraftValues).catch(showError);
    }, 500);
  };
  openPopover({
    mode: "create",
    anchor: { x: info.jsEvent?.clientX ?? window.innerWidth / 2, y: info.jsEvent?.clientY ?? window.innerHeight / 3 },
    values,
    onTitleChange: (title) => {
      draft?.setProp("title", title);
    },
    onColorChange: (color) => {
      if (draft) {
        applyEventColor(draft, color);
      }
    },
    onValuesChange: queueDraftSave,
    onSave: async (v) => {
      window.clearTimeout(draftSaveTimer);
      await persistDraft(v, true).catch(showError);
    },
    onClose: () => {
      window.clearTimeout(draftSaveTimer);
      if (draftInteracted) {
        persistDraft(latestDraftValues, true).catch(showError);
      } else {
        draft?.remove();
      }
      suppressUntil = Date.now() + 250;
    }
  });
}

function onDateClick(info: DateClickArg): void {
  if (Date.now() < suppressUntil) {
    return;
  }
  if (info.allDay) {
    calendar.select({ start: info.date, allDay: true });
    return;
  }
  calendar.select(info.date, addMinutes(info.date, defaultDurationMinutes));
}

function onEventClick(info: EventClickArg): void {
  info.jsEvent.preventDefault();
  const stored = store.get(info.event.id);
  if (!stored) {
    return;
  }
  const oldColor = stored.color;
  const oldTitle = stored.title;
  let editInteracted = false;
  let latestEditValues = eventToValues(stored);
  let editSaveTimer = 0;
  const persistEdit = async (v: PopoverValues) => {
    editInteracted = true;
    latestEditValues = v;
    rememberColor(v.color);
    const range = valuesToRange(v);
    await store.update(stored.id, {
      title: v.title,
      start: range.start,
      end: range.end,
      allDay: range.allDay,
      color: v.color,
      note: v.note
    });
  };
  const queueEditSave = (v: PopoverValues) => {
    editInteracted = true;
    latestEditValues = v;
    applyValuesToEvent(info.event, v);
    window.clearTimeout(editSaveTimer);
    editSaveTimer = window.setTimeout(() => {
      persistEdit(latestEditValues).catch(showError);
    }, 500);
  };
  openPopover({
    mode: "edit",
    anchor: {
      x: info.jsEvent.clientX,
      y: info.jsEvent.clientY,
      rect: info.el.getBoundingClientRect()
    },
    values: latestEditValues,
    onTitleChange: (title) => {
      info.event.setProp("title", title);
    },
    onColorChange: (color) => {
      applyEventColor(info.event, color);
    },
    onValuesChange: queueEditSave,
    onSave: async (v) => {
      window.clearTimeout(editSaveTimer);
      await persistEdit(v).catch(showError);
      refresh();
    },
    onDelete: async () => {
      window.clearTimeout(editSaveTimer);
      await store.remove(stored.id);
      refresh();
    },
    onClose: () => {
      window.clearTimeout(editSaveTimer);
      if (editInteracted) {
        persistEdit(latestEditValues).catch(showError);
      } else {
        info.event.setProp("title", oldTitle);
        applyEventColor(info.event, oldColor);
      }
    }
  });
}

async function onEventMutate(info: EventDropArg | EventResizeDoneArg): Promise<void> {
  closePopover(true);
  const event = info.event;
  const stored = store.get(event.id);
  if (!stored) {
    return;
  }
  const range = serializeRange({ start: event.start, end: event.end, allDay: event.allDay });
  try {
    await store.update(event.id, { start: range.start, end: range.end, allDay: event.allDay });
  } catch (err) {
    info.revert();
    showError(err);
  }
}

function showError(err: unknown): void {
  const banner = document.querySelector(".cb-error") as HTMLElement;
  banner.textContent = `保存失败：${err instanceof Error ? err.message : String(err)}`;
  banner.style.display = "";
  window.setTimeout(() => {
    banner.style.display = "none";
  }, 4000);
}

/* ---------- 锚点日期（锚定日程块与某天的关联） ---------- */

function currentViewKey(): ViewKey {
  return VIEW_KEY[calendar.view.type] || "week";
}

function anchorLabel(view: ViewKey): string {
  if (!anchorDate) {
    return "";
  }
  if (view === "week") {
    const d = parseDate(anchorDate);
    return getIsoWeek(d);
  }
  return anchorDate;
}

function isShowingAnchor(view: ViewKey): boolean {
  if (!anchorDate || !calendar) {
    return false;
  }
  const currentStart = fmtDate(calendar.view.currentStart);
  if (view === "week") {
    return getIsoWeek(parseDate(currentStart)) === getIsoWeek(parseDate(anchorDate));
  }
  return currentStart === anchorDate;
}

function parseWeekLabel(input: string): string | null {
  const match = input.trim().match(/^(\d{4})-[wW](\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) {
    return null;
  }
  const start = isoWeekStart(year, week);
  const label = getIsoWeek(start);
  return label === `${year}-W${String(week).padStart(2, "0")}` ? fmtDate(start) : null;
}

async function saveBlockSettings(nextDate: string, nextDuration: number): Promise<void> {
  anchorDate = nextDate;
  defaultDurationMinutes = parseDurationMinutes(String(nextDuration));
  calendar.setOption("defaultTimedEventDuration", durationToFullCalendar(defaultDurationMinutes));
  if (blockId) {
    await setBlockAttrs(blockId, {
      [DATE_ATTR]: anchorDate,
      [VIEW_ATTR]: currentViewKey(),
      [DURATION_ATTR]: String(defaultDurationMinutes)
    });
  }
  calendar.gotoDate(anchorDate);
  syncToolbar(document.getElementById("app")!);
}

function closeAnchorEditor(): void {
  if (!anchorEditor) {
    return;
  }
  const { el, dispose } = anchorEditor;
  anchorEditor = null;
  dispose();
  el.remove();
}

function positionAnchorEditor(el: HTMLElement, anchor: HTMLElement): void {
  const margin = 8;
  const rect = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  let x = rect.left;
  let y = rect.bottom + 8;
  x = Math.min(Math.max(x, margin), Math.max(window.innerWidth - width - margin, margin));
  y = Math.min(Math.max(y, margin), Math.max(window.innerHeight - height - margin, margin));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function editAnchorDate(anchor: HTMLElement): void {
  closePopover(true);
  closeAnchorEditor();
  const view = currentViewKey();
  const current = anchorLabel(view);
  const el = document.createElement("div");
  el.className = "cb-anchor-editor";
  el.setAttribute("role", "dialog");
  el.innerHTML = `
    <label class="cb-anchor-label">${view === "week" ? "绑定周" : "绑定日期"}</label>
    <input class="cb-anchor-input" type="${view === "week" ? "week" : "date"}">
    <label class="cb-anchor-label">默认时长</label>
    <select class="cb-duration-select">
      ${DURATION_OPTIONS.map((m) => `<option value="${m}">${durationLabel(m)}</option>`).join("")}
    </select>
    <div class="cb-anchor-actions">
      <button type="button" class="cb-anchor-cancel">取消</button>
      <button type="button" class="cb-anchor-save">保存</button>
    </div>
  `;
  document.body.appendChild(el);

  const input = el.querySelector(".cb-anchor-input") as HTMLInputElement;
  const durationSelect = el.querySelector(".cb-duration-select") as HTMLSelectElement;
  const saveBtn = el.querySelector(".cb-anchor-save") as HTMLButtonElement;
  const cancelBtn = el.querySelector(".cb-anchor-cancel") as HTMLButtonElement;
  input.value = current;
  if (!DURATION_OPTIONS.includes(defaultDurationMinutes)) {
    const option = document.createElement("option");
    option.value = String(defaultDurationMinutes);
    option.textContent = durationLabel(defaultDurationMinutes);
    durationSelect.appendChild(option);
  }
  durationSelect.value = String(defaultDurationMinutes);

  const save = async () => {
    const value = input.value.trim();
    const nextDate = view === "week" ? parseWeekLabel(value) : (isValidDateStr(value) ? value : null);
    if (!nextDate) {
      showError(new Error(view === "week" ? "周格式应为 YYYY-Www，例如 2026-W24" : "日期格式应为 YYYY-MM-DD，例如 2026-06-12"));
      input.focus();
      return;
    }
    try {
      await saveBlockSettings(nextDate, parseDurationMinutes(durationSelect.value));
      closeAnchorEditor();
    } catch (err) {
      showError(err);
    }
  };

  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", closeAnchorEditor);

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeAnchorEditor();
    }
    if (event.key === "Enter") {
      event.preventDefault();
      save();
    }
  };
  el.addEventListener("keydown", onKeydown);

  const onOutsideMousedown = (event: MouseEvent) => {
    if (!el.contains(event.target as Node) && event.target !== anchor) {
      closeAnchorEditor();
    }
  };
  const timer = window.setTimeout(() => {
    document.addEventListener("mousedown", onOutsideMousedown, true);
  }, 0);
  const dispose = () => {
    window.clearTimeout(timer);
    document.removeEventListener("mousedown", onOutsideMousedown, true);
  };
  anchorEditor = { el, dispose };
  positionAnchorEditor(el, anchor);
  input.focus();
  input.select();
}

/* ---------- 工具栏 ---------- */

function buildToolbar(root: HTMLElement, view: ViewKey): void {
  const anchor = anchorLabel(view);
  root.innerHTML = `
    <div class="cb-toolbar">
      <div class="cb-toolbar-left">
        <button type="button" class="cb-icon-btn cb-btn-settings" aria-label="修改绑定${view === "week" ? "周" : "日期"}" title="修改绑定${view === "week" ? "周" : "日期"}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5l-2-3.5l-2.4 1a8.4 8.4 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8.4 8.4 0 0 0 7 6.5l-2.4-1l-2 3.5l2 1.5c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2 1.5l2 3.5l2.4-1a8.4 8.4 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a8.4 8.4 0 0 0 2.6-1.5l2.4 1l2-3.5l-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>
        </button>
      </div>
      <div class="cb-toolbar-center">
        <button type="button" class="cb-nav cb-nav-prev" aria-label="上一页">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="M15.4 16.6L10.8 12l4.6-4.6L14 6l-6 6l6 6l1.4-1.4Z"/></svg>
        </button>
        <button type="button" class="cb-btn cb-btn-anchor">${anchor || "锚定日期"}</button>
        <button type="button" class="cb-nav cb-nav-next" aria-label="下一页">
          <svg viewBox="0 0 24 24"><path fill="currentColor" d="m8.6 16.6l4.6-4.6l-4.6-4.6L10 6l6 6l-6 6l-1.4-1.4Z"/></svg>
        </button>
      </div>
      <div class="cb-toolbar-right">
        <button type="button" class="cb-icon-btn cb-btn-new" aria-label="新建日程" title="新建日程">＋</button>
      </div>
    </div>
    <div class="cb-error" style="display:none"></div>
    <div class="cb-calendar"></div>
  `;

  root.querySelector(".cb-btn-settings")!.addEventListener("click", (event) => {
    editAnchorDate(event.currentTarget as HTMLElement);
  });
  root.querySelector(".cb-btn-anchor")!.addEventListener("click", () => {
    if (anchorDate) {
      calendar.gotoDate(anchorDate);
    }
  });
  root.querySelector(".cb-nav-prev")!.addEventListener("click", () => calendar.prev());
  root.querySelector(".cb-nav-next")!.addEventListener("click", () => calendar.next());
  root.querySelector(".cb-btn-new")!.addEventListener("click", (event) => {
    const base = anchorDate ? parseDate(anchorDate) : new Date();
    base.setMinutes(0, 0, 0);
    base.setHours(base.getHours() + 1);
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    openPopover({
      mode: "create",
      anchor: { x: rect.left, y: rect.bottom + 6, rect },
      values: {
        title: "",
        allDay: false,
        startDate: fmtDate(base),
        startTime: fmtTime(base),
        endDate: fmtDate(base),
        endTime: fmtTime(addMinutes(base, defaultDurationMinutes)),
        color: lastColor(),
        note: ""
      },
      onSave: async (v) => {
        rememberColor(v.color);
        const range = valuesToRange(v);
        await store.add({
          id: newEventId(),
          title: v.title,
          start: range.start,
          end: range.end,
          allDay: range.allDay,
          color: v.color,
          note: v.note,
          docId: docId
        });
        refresh();
        calendar.gotoDate(range.start);
      }
    });
  });
}

function syncToolbar(root: HTMLElement): void {
  const key = currentViewKey();
  const anchorBtn = root.querySelector(".cb-btn-anchor") as HTMLElement;
  if (anchorBtn) {
    anchorBtn.textContent = anchorLabel(key) || (key === "week" ? "锚定周" : "锚定日期");
    anchorBtn.classList.toggle("cb-btn-anchor--active", isShowingAnchor(key));
  }
}

/* ---------- 状态持久化 ---------- */

let persistTimer = 0;
function persistViewState(): void {
  if (!blockId) {
    return;
  }
  const key = currentViewKey();
  if (key === persistedViewKey) {
    return;
  }
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    setBlockAttrs(blockId, {
      [VIEW_ATTR]: key
    })
      .then(() => {
        persistedViewKey = key;
      })
      .catch(() => {
        // 独立打开或离线时忽略
      });
  }, 400);
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) {
    return false;
  }
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

/* ---------- 启动 ---------- */

async function boot(): Promise<void> {
  initThemeBridge();

  const frame = window.frameElement as HTMLElement | null;
  const blockEl = (frame?.closest("[data-node-id]") as HTMLElement | null) || null;
  blockId = blockEl?.getAttribute("data-node-id") || "";

  // 新插入的挂件块给一个合适的默认高度（思源把高度存于块的 style 属性）
  if (blockEl && !blockEl.style.height) {
    blockEl.style.height = DEFAULT_HEIGHT;
    if (blockId) {
      setBlockAttrs(blockId, { style: `height: ${DEFAULT_HEIGHT};` }).catch(() => {});
    }
  }

  // 获取所属文档的 root_id
  if (blockId) {
    docId = await getRootId(blockId);
  }
  store.docId = docId;

  const params = new URLSearchParams(window.location.search);
  let view = (params.get("view") as ViewKey) || "week";
  let date = params.get("date") || "";
  if (blockId) {
    try {
      const attrs = await getBlockAttrs(blockId);
      if (attrs[VIEW_ATTR] && VIEW_MAP[attrs[VIEW_ATTR] as ViewKey]) {
        view = attrs[VIEW_ATTR] as ViewKey;
      }
      if (attrs[DATE_ATTR] && isValidDateStr(attrs[DATE_ATTR])) {
        date = attrs[DATE_ATTR];
      }
      defaultDurationMinutes = parseDurationMinutes(attrs[DURATION_ATTR]);

      // 没有手动绑定时，才从文档标题推断日期/周。
      const docTitle = await getDocTitle(blockId);
      const parsedDate = parseDateFromTitle(docTitle);
      if (!date && parsedDate) {
        date = parsedDate;
      }
    } catch {
      // 属性读取失败不阻塞渲染
    }
  }
  if (!VIEW_MAP[view]) {
    view = "week";
  }
  persistedViewKey = view;

  // 锚定日期：优先用标题解析，否则用属性或今日
  anchorDate = date || fmtDate(new Date());

  const root = document.getElementById("app")!;
  buildToolbar(root, view);

  let storeReady = true;
  try {
    await store.load();
  } catch (err) {
    storeReady = false;
    console.error("schedule-block: 日程数据加载失败", err);
  }

  calendar = new Calendar(root.querySelector(".cb-calendar") as HTMLElement, {
    plugins: [timeGridPlugin, interactionPlugin],
    locale: zhCnLocale,
    firstDay: 1,
    initialView: VIEW_MAP[view],
    initialDate: anchorDate || undefined,
    headerToolbar: false,
    height: "100%",
    expandRows: true,
    nowIndicator: true,
    selectable: true,
    selectMirror: true,
    unselectAuto: false,
    selectMinDistance: 5,
    editable: true,
    eventResizableFromStart: true,
    eventDurationEditable: true,
    dayMaxEvents: true,
    allDaySlot: true,
    slotMinTime: "00:00:00",
    slotMaxTime: "24:00:00",
    scrollTime: "07:30:00",
    scrollTimeReset: false,
    slotDuration: "00:30:00",
    snapDuration: "00:15:00",
    defaultTimedEventDuration: durationToFullCalendar(defaultDurationMinutes),
    slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    moreLinkText: (n) => `还有 ${n} 项`,
    dayHeaderContent: (arg) => {
      const dow = arg.date.toLocaleDateString("zh-CN", { weekday: "short" });
      const dateLabel = `${arg.date.getMonth() + 1}月${arg.date.getDate()}日`;
      const lunarLabel = lunarDateLabel(arg.date);
      const todayClass = arg.isToday ? " cb-dh--today" : "";
      if (VIEW_KEY[arg.view.type] === "day") {
        return {
          html: `<div class="cb-dh cb-dh--single${todayClass}"><span class="cb-dh-date">${dateLabel}</span><span class="cb-dh-main">${dow}</span><span class="cb-dh-lunar">${lunarLabel}</span></div>`
        };
      }
      return {
        html: `<div class="cb-dh cb-dh--week${todayClass}"><span class="cb-dh-date">${dateLabel}</span><span class="cb-dh-main">${dow}</span><span class="cb-dh-lunar">${lunarLabel}</span></div>`
      };
    },
    events: (_info, success) => success(store.visibleEvents().map(toFC)),
    select: onSelect,
    dateClick: onDateClick,
    eventClick: onEventClick,
    eventDrop: onEventMutate,
    eventResize: onEventMutate,
    datesSet: () => {
      syncToolbar(root);
      persistViewState();
    }
  });
  calendar.render();
  syncToolbar(root);

  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.key.toLowerCase() !== "z" || isEditableTarget(event.target)) {
      return;
    }
    event.preventDefault();
    store.undo()
      .then((ok) => {
        if (ok) {
          refresh();
        }
      })
      .catch(showError);
  });

  let isDirty = false;
  store.onRemoteChange = () => {
    const calendarEl = root.querySelector(".cb-calendar") as HTMLElement;
    const isVisible = calendarEl && calendarEl.offsetWidth > 0;
    if (isVisible) {
      refresh();
    } else {
      isDirty = true;
    }
  };

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        if (isDirty) {
          isDirty = false;
          refresh();
        } else {
          calendar.updateSize();
        }
      }
    }
  });
  const calendarEl = root.querySelector(".cb-calendar") as HTMLElement;
  if (calendarEl) {
    resizeObserver.observe(calendarEl);
  }

  if (!storeReady) {
    showError(new Error("无法读取日程数据，请在思源中打开"));
  }
}

boot();
