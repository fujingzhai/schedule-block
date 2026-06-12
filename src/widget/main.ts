import { Calendar, DateSelectArg, EventApi, EventClickArg, EventDropArg, EventHoveringArg, EventInput } from "@fullcalendar/core";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin, { DateClickArg, EventResizeDoneArg } from "@fullcalendar/interaction";
import { getBlockAttrs, setBlockAttrs, getDocTitle, getRootId } from "./api";
import { CalEvent, EventStore } from "./store";
import { WeatherKind, WeatherStore, WEATHER_LABELS } from "./weather";
import { initThemeBridge } from "./theme";
import {
  closePopover,
  DEFAULT_COLOR,
  openPopover,
  PALETTE,
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
// 完整显示 24 小时所需高度：时间网格 48 槽 × 24px = 1152px ＋ 表头/全天行/工具栏约 167px，再留余量
const DEFAULT_HEIGHT = "1330px";
const DEFAULT_DURATION_MINUTES = 30;
const DURATION_OPTIONS = [15, 30, 45, 60];
const LAST_COLOR_KEY = "schedule-block-last-color";
const SNAP_MINUTES = 15;

const store = new EventStore();
const weatherStore = new WeatherStore();
let calendar: Calendar;
let blockId = "";
let docId = "";
let anchorDate = "";
let persistedViewKey: ViewKey | "" = "";
let defaultDurationMinutes = DEFAULT_DURATION_MINUTES;
let suppressUntil = 0;
let anchorEditor: { el: HTMLElement; dispose(): void } | null = null;
let weatherPicker: { el: HTMLElement; date: string; dispose(): void } | null = null;
let colorFilterPicker: { el: HTMLElement; dispose(): void } | null = null;
let noteTooltip: HTMLElement | null = null;
let noteTooltipDispose: (() => void) | null = null;
const visibleColors = new Set<string>(PALETTE);
let toolbarCreatePopoverOpen = false;

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

function roundedCurrentDate(): Date {
  const date = new Date();
  date.setSeconds(0, 0);
  const minutes = date.getMinutes();
  const rounded = Math.ceil(minutes / SNAP_MINUTES) * SNAP_MINUTES;
  if (rounded >= 60) {
    date.setHours(date.getHours() + 1, 0, 0, 0);
  } else {
    date.setMinutes(rounded, 0, 0);
  }
  return date;
}

function weatherIcon(kind: WeatherKind | ""): string {
  if (kind === "sunny") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 2.5v3M12 18.5v3M4.6 4.6l2.1 2.1M17.3 17.3l2.1 2.1M2.5 12h3M18.5 12h3M4.6 19.4l2.1-2.1M17.3 6.7l2.1-2.1" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  if (kind === "overcast") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 17.5h10a4 4 0 0 0 .4-8A5.8 5.8 0 0 0 6.6 8a4.8 4.8 0 0 0 .6 9.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`;
  }
  if (kind === "rain") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 14.5h10a4 4 0 0 0 .4-8A5.8 5.8 0 0 0 6.6 5a4.8 4.8 0 0 0 .6 9.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 18.5l-1 2M12.5 18.5l-1 2M17 18.5l-1 2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  }
  if (kind === "snow") {
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.2 14.5h10a4 4 0 0 0 .4-8A5.8 5.8 0 0 0 6.6 5a4.8 4.8 0 0 0 .6 9.5Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 19h.01M13 20.5h.01M17 19h.01" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`;
  }
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 13.5a4.8 4.8 0 0 1 7.6 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;
}

function weatherButtonHtml(date: string): string {
  const kind = weatherStore.get(date) || "";
  const label = kind ? WEATHER_LABELS[kind] : "选择天气";
  const activeClass = kind ? " cb-weather-btn--active" : "";
  return `<button type="button" class="cb-weather-btn${activeClass}" data-date="${date}" data-weather="${kind}" aria-label="${label}" title="${label}">${weatherIcon(kind)}</button>`;
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

function isColorFilterAll(): boolean {
  return visibleColors.size === PALETTE.length;
}

function visibleFilteredEvents(): CalEvent[] {
  const events = store.visibleEvents();
  if (isColorFilterAll()) {
    return events;
  }
  return events.filter((event) => visibleColors.has(event.color));
}

function syncColorFilterButton(root: HTMLElement): void {
  const btn = root.querySelector(".cb-btn-filter") as HTMLElement | null;
  if (btn) {
    btn.classList.toggle("cb-icon-btn--active", !isColorFilterAll());
  }
}

function selectAllColors(): void {
  visibleColors.clear();
  for (const color of PALETTE) {
    visibleColors.add(color);
  }
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

function positionNoteTooltip(x: number, y: number): void {
  if (!noteTooltip) {
    return;
  }
  const gap = 12;
  const margin = 8;
  const rect = noteTooltip.getBoundingClientRect();
  let left = x + gap;
  let top = y + gap;
  if (left + rect.width + margin > window.innerWidth) {
    left = x - rect.width - gap;
  }
  if (top + rect.height + margin > window.innerHeight) {
    top = y - rect.height - gap;
  }
  noteTooltip.style.left = `${Math.max(margin, left)}px`;
  noteTooltip.style.top = `${Math.max(margin, top)}px`;
}

function hideEventNoteTooltip(): void {
  noteTooltipDispose?.();
  noteTooltipDispose = null;
  noteTooltip?.remove();
  noteTooltip = null;
}

function showEventNoteTooltip(info: EventHoveringArg): void {
  const note = store.get(info.event.id)?.note.trim();
  if (!note) {
    return;
  }
  hideEventNoteTooltip();
  const tooltip = document.createElement("div");
  tooltip.className = "cb-note-tooltip";
  tooltip.textContent = note;
  document.body.appendChild(tooltip);
  noteTooltip = tooltip;

  const move = (event: MouseEvent) => positionNoteTooltip(event.clientX, event.clientY);
  info.el.addEventListener("mousemove", move);
  noteTooltipDispose = () => info.el.removeEventListener("mousemove", move);

  const event = info.jsEvent;
  if (event) {
    positionNoteTooltip(event.clientX, event.clientY);
  } else {
    const rect = info.el.getBoundingClientRect();
    positionNoteTooltip(rect.right, rect.top);
  }
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
    },
    onCancel: () => {
      window.clearTimeout(draftSaveTimer);
      draft?.remove();
      if (draftSavedId) {
        store.remove(draftSavedId).then(refresh).catch(showError);
      }
      suppressUntil = Date.now() + 250;
    }
  });
}

let lastEmptyClick: { time: number; x: number; y: number; allDay: boolean; date: Date | null } = { time: 0, x: 0, y: 0, allDay: false, date: null };
let lastCreateFromClick = 0;

/** 在空白处新建（双击触发）：按默认时长生成选区，复用拖选的创建流程 */
function createAtPoint(date: Date, allDay: boolean): void {
  lastCreateFromClick = Date.now();
  if (allDay) {
    calendar.select({ start: date, allDay: true });
    return;
  }
  calendar.select(date, addMinutes(date, defaultDurationMinutes));
}

function onDateClick(info: DateClickArg): void {
  if (Date.now() < suppressUntil) {
    return;
  }
  // 对齐 Notion：空白处单击不新建，双击或拖选才新建。
  // FullCalendar 的 jsEvent 是 PointerEvent（Chromium 下 detail 恒为 0），无法用原生连击计数，
  // 这里按"450ms 内同一位置（8px 内）连点两次"判定双击。
  const now = Date.now();
  const x = info.jsEvent?.clientX ?? 0;
  const y = info.jsEvent?.clientY ?? 0;
  const isDouble = now - lastEmptyClick.time < 450
    && Math.abs(x - lastEmptyClick.x) < 8
    && Math.abs(y - lastEmptyClick.y) < 8
    && info.allDay === lastEmptyClick.allDay;
  lastEmptyClick = isDouble
    ? { time: 0, x: 0, y: 0, allDay: false, date: null }
    : { time: now, x, y, allDay: info.allDay, date: info.date };
  if (!isDouble) {
    return;
  }
  createAtPoint(info.date, info.allDay);
}

function onEventClick(info: EventClickArg): void {
  info.jsEvent.preventDefault();
  hideEventNoteTooltip();
  const stored = store.get(info.event.id);
  if (!stored) {
    return;
  }
  const original = { ...stored };
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
        info.event.setProp("title", original.title);
        applyEventColor(info.event, original.color);
      }
    },
    onCancel: () => {
      window.clearTimeout(editSaveTimer);
      if (editInteracted) {
        // 回滚到打开弹窗前的原始内容
        store.update(stored.id, {
          title: original.title,
          start: original.start,
          end: original.end,
          allDay: original.allDay,
          color: original.color,
          note: original.note
        }).then(refresh).catch(showError);
      } else {
        info.event.setProp("title", original.title);
        applyEventColor(info.event, original.color);
      }
    }
  });
}

async function onEventMutate(info: EventDropArg | EventResizeDoneArg): Promise<void> {
  closePopover(true);
  hideEventNoteTooltip();
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

function closeWeatherPicker(): void {
  if (!weatherPicker) {
    return;
  }
  const { el, dispose } = weatherPicker;
  weatherPicker = null;
  dispose();
  el.remove();
}

function closeColorFilterPicker(): void {
  if (!colorFilterPicker) {
    return;
  }
  const { el, dispose } = colorFilterPicker;
  colorFilterPicker = null;
  dispose();
  el.remove();
}

function syncColorFilterPicker(): void {
  if (!colorFilterPicker) {
    return;
  }
  const allBtn = colorFilterPicker.el.querySelector(".cb-filter-all") as HTMLElement | null;
  allBtn?.classList.toggle("cb-filter-all--active", isColorFilterAll());
  colorFilterPicker.el.querySelectorAll<HTMLButtonElement>(".cb-filter-swatch").forEach((btn) => {
    const color = btn.dataset.color || "";
    btn.classList.toggle("cb-filter-swatch--active", visibleColors.has(color));
  });
}

function openColorFilterPicker(anchor: HTMLElement): void {
  if (colorFilterPicker) {
    closeColorFilterPicker();
    return;
  }
  closePopover(true);
  closeAnchorEditor();
  closeWeatherPicker();
  const el = document.createElement("div");
  el.className = "cb-filter-picker";
  el.setAttribute("role", "dialog");
  el.innerHTML = `<button type="button" class="cb-filter-all" aria-label="显示全部颜色" title="显示全部颜色">全部</button>` + PALETTE.map((color) => {
    const active = visibleColors.has(color) ? " cb-filter-swatch--active" : "";
    return `<button type="button" class="cb-filter-swatch${active}" data-color="${color}" style="background:${color}" aria-label="筛选颜色 ${color}" title="筛选颜色 ${color}"></button>`;
  }).join("");
  document.body.appendChild(el);

  el.querySelector<HTMLButtonElement>(".cb-filter-all")?.addEventListener("click", () => {
    selectAllColors();
    syncColorFilterPicker();
    syncColorFilterButton(document.getElementById("app")!);
    refresh();
  });

  el.querySelectorAll<HTMLButtonElement>(".cb-filter-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      const color = btn.dataset.color || "";
      if (!color) {
        return;
      }
      if (isColorFilterAll()) {
        visibleColors.clear();
        visibleColors.add(color);
      } else if (visibleColors.size === 1 && visibleColors.has(color)) {
        selectAllColors();
      } else if (visibleColors.has(color)) {
        visibleColors.delete(color);
        if (visibleColors.size === 0) {
          selectAllColors();
        }
      } else {
        visibleColors.add(color);
      }
      syncColorFilterPicker();
      syncColorFilterButton(document.getElementById("app")!);
      refresh();
    });
  });

  const onOutsideMousedown = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!el.contains(target) && !anchor.contains(target)) {
      closeColorFilterPicker();
    }
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeColorFilterPicker();
    }
  };
  const timer = window.setTimeout(() => {
    document.addEventListener("mousedown", onOutsideMousedown, true);
    document.addEventListener("keydown", onKeydown, true);
  }, 0);
  const dispose = () => {
    window.clearTimeout(timer);
    document.removeEventListener("mousedown", onOutsideMousedown, true);
    document.removeEventListener("keydown", onKeydown, true);
  };
  colorFilterPicker = { el, dispose };

  const margin = 8;
  const gap = 8;
  const rect = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  let x = rect.left;
  let y = rect.bottom + gap;
  x = Math.min(Math.max(x, margin), Math.max(window.innerWidth - width - margin, margin));
  if (y + height > window.innerHeight - margin) {
    y = rect.top - height - gap;
  }
  y = Math.min(Math.max(y, margin), Math.max(window.innerHeight - height - margin, margin));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

function refreshWeatherHeaders(): void {
  document.querySelectorAll<HTMLElement>(".cb-weather-btn[data-date]").forEach((btn) => {
    const date = btn.dataset.date || "";
    const kind = weatherStore.get(date) || "";
    const label = kind ? WEATHER_LABELS[kind] : "选择天气";
    btn.dataset.weather = kind;
    btn.classList.toggle("cb-weather-btn--active", Boolean(kind));
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
    btn.innerHTML = weatherIcon(kind);
  });
}

function openWeatherPicker(anchor: HTMLElement, date: string): void {
  if (weatherPicker?.date === date) {
    closeWeatherPicker();
    return;
  }
  closePopover(true);
  closeAnchorEditor();
  closeWeatherPicker();
  closeColorFilterPicker();
  const current = weatherStore.get(date) || "";
  const el = document.createElement("div");
  el.className = "cb-weather-picker";
  el.setAttribute("role", "dialog");
  el.innerHTML = (Object.keys(WEATHER_LABELS) as WeatherKind[]).map((kind) => {
    const active = kind === current ? " cb-weather-option--active" : "";
    const label = WEATHER_LABELS[kind];
    return `<button type="button" class="cb-weather-option${active}" data-weather="${kind}" aria-label="${label}" title="${label}">${weatherIcon(kind)}</button>`;
  }).join("");
  document.body.appendChild(el);

  el.querySelectorAll<HTMLButtonElement>(".cb-weather-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.dataset.weather as WeatherKind;
      const next = kind === weatherStore.get(date) ? "" : kind;
      weatherStore.set(date, next).then(() => {
        refreshWeatherHeaders();
        closeWeatherPicker();
      }).catch(showError);
    });
  });

  const onOutsideMousedown = (event: MouseEvent) => {
    const target = event.target as Node;
    if (!el.contains(target) && !anchor.contains(target)) {
      closeWeatherPicker();
    }
  };
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeWeatherPicker();
    }
  };
  const timer = window.setTimeout(() => {
    document.addEventListener("mousedown", onOutsideMousedown, true);
    document.addEventListener("keydown", onKeydown, true);
  }, 0);
  const dispose = () => {
    window.clearTimeout(timer);
    document.removeEventListener("mousedown", onOutsideMousedown, true);
    document.removeEventListener("keydown", onKeydown, true);
  };
  weatherPicker = { el, date, dispose };

  const margin = 8;
  const gap = 8;
  const rect = anchor.getBoundingClientRect();
  const { width, height } = el.getBoundingClientRect();
  let x = rect.left + rect.width / 2 - width / 2;
  let y = rect.bottom + gap;
  x = Math.min(Math.max(x, margin), Math.max(window.innerWidth - width - margin, margin));
  if (y + height > window.innerHeight - margin) {
    y = rect.top - height - gap;
  }
  y = Math.min(Math.max(y, margin), Math.max(window.innerHeight - height - margin, margin));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
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
  if (anchorEditor) {
    closeAnchorEditor();
    return;
  }
  closePopover(true);
  closeAnchorEditor();
  closeWeatherPicker();
  closeColorFilterPicker();
  const view = currentViewKey();
  const current = anchorLabel(view);
  const el = document.createElement("div");
  el.className = "cb-anchor-editor";
  el.setAttribute("role", "dialog");
  el.innerHTML = `
    <label class="cb-anchor-label">${view === "week" ? "绑定周次" : "绑定日期"}</label>
    <input class="cb-anchor-input" type="${view === "week" ? "week" : "date"}">
    <label class="cb-anchor-label">默认事件时长</label>
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
    const target = event.target as Node;
    if (!el.contains(target) && !anchor.contains(target)) {
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
        <button type="button" class="cb-icon-btn cb-btn-settings" aria-label="修改绑定${view === "week" ? "周次" : "日期"}" title="修改绑定${view === "week" ? "周次" : "日期"}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5l-2-3.5l-2.4 1a8.4 8.4 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8.4 8.4 0 0 0 7 6.5l-2.4-1l-2 3.5l2 1.5c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2 1.5l2 3.5l2.4-1a8.4 8.4 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a8.4 8.4 0 0 0 2.6-1.5l2.4 1l2-3.5l-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>
        </button>
        <button type="button" class="cb-icon-btn cb-btn-filter" aria-label="按颜色筛选日程" title="按颜色筛选日程">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 5h18l-7 8v5.2l-4 2V13L3 5Z"/></svg>
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
  root.querySelector(".cb-btn-filter")!.addEventListener("click", (event) => {
    openColorFilterPicker(event.currentTarget as HTMLElement);
  });
  root.querySelector(".cb-btn-anchor")!.addEventListener("click", () => {
    if (anchorDate) {
      calendar.gotoDate(anchorDate);
    }
  });
  root.querySelector(".cb-nav-prev")!.addEventListener("click", () => calendar.prev());
  root.querySelector(".cb-nav-next")!.addEventListener("click", () => calendar.next());
  root.querySelector(".cb-btn-new")!.addEventListener("click", (event) => {
    if (toolbarCreatePopoverOpen) {
      closePopover();
      return;
    }
    const base = roundedCurrentDate();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const values: PopoverValues = {
      title: "",
      allDay: false,
      startDate: fmtDate(base),
      startTime: fmtTime(base),
      endDate: fmtDate(base),
      endTime: fmtTime(addMinutes(base, defaultDurationMinutes)),
      color: lastColor(),
      note: ""
    };
    let savedId = "";
    let interacted = false;
    let latestValues = values;
    let saveTimer = 0;
    const persistNew = async (v: PopoverValues, close = false) => {
      interacted = true;
      latestValues = v;
      rememberColor(v.color);
      const range = valuesToRange(v);
      if (!savedId) {
        savedId = newEventId();
        await store.add({
          id: savedId,
          title: v.title,
          start: range.start,
          end: range.end,
          allDay: range.allDay,
          color: v.color,
          note: v.note,
          docId: docId
        });
      } else {
        await store.update(savedId, {
          title: v.title,
          start: range.start,
          end: range.end,
          allDay: range.allDay,
          color: v.color,
          note: v.note
        });
      }
      if (close) {
        refresh();
        calendar.gotoDate(range.start);
      }
    };
    openPopover({
      mode: "create",
      anchor: { x: rect.left, y: rect.bottom + 6, rect },
      ignoreOutside: [target],
      values,
      onValuesChange: (v) => {
        interacted = true;
        latestValues = v;
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => {
          persistNew(latestValues).catch(showError);
        }, 500);
      },
      onSave: async (v) => {
        toolbarCreatePopoverOpen = false;
        window.clearTimeout(saveTimer);
        await persistNew(v, true).catch(showError);
      },
      onClose: () => {
        toolbarCreatePopoverOpen = false;
        window.clearTimeout(saveTimer);
        if (interacted) {
          persistNew(latestValues, true).catch(showError);
        }
      },
      onCancel: () => {
        toolbarCreatePopoverOpen = false;
        window.clearTimeout(saveTimer);
        if (savedId) {
          store.remove(savedId).then(refresh).catch(showError);
        }
      }
    });
    toolbarCreatePopoverOpen = true;
  });
  syncColorFilterButton(root);
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
  try {
    await weatherStore.load();
  } catch (err) {
    console.warn("schedule-block: 天气数据加载失败", err);
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
    // 槽高 24px / 30 分钟，12px 恰为 15 分钟：保证最短日程的显示高度与真实时长一致，不越界遮挡下一条
    eventMinHeight: 12,
    defaultTimedEventDuration: durationToFullCalendar(defaultDurationMinutes),
    slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    moreLinkText: (n) => `还有 ${n} 项`,
    dayHeaderContent: (arg) => {
      const dow = arg.date.toLocaleDateString("zh-CN", { weekday: "short" });
      const dateLabel = `${arg.date.getMonth() + 1}月${arg.date.getDate()}日`;
      const lunarLabel = lunarDateLabel(arg.date);
      const dateKey = fmtDate(arg.date);
      const todayClass = arg.isToday ? " cb-dh--today" : "";
      const weather = weatherButtonHtml(dateKey);
      if (VIEW_KEY[arg.view.type] === "day") {
        return {
          html: `<div class="cb-dh cb-dh--single${todayClass}"><div class="cb-dh-top"><span class="cb-dh-date">${dateLabel}</span><span class="cb-dh-lunar">${lunarLabel}</span></div><div class="cb-dh-status"><span class="cb-dh-main">${dow}</span>${weather}</div></div>`
        };
      }
      return {
        html: `<div class="cb-dh cb-dh--week${todayClass}"><div class="cb-dh-top"><span class="cb-dh-date">${dateLabel}</span><span class="cb-dh-lunar">${lunarLabel}</span></div><div class="cb-dh-status"><span class="cb-dh-main">${dow}</span>${weather}</div></div>`
      };
    },
    events: (_info, success) => success(visibleFilteredEvents().map(toFC)),
    select: onSelect,
    dateClick: onDateClick,
    eventClick: onEventClick,
    eventMouseEnter: showEventNoteTooltip,
    eventMouseLeave: hideEventNoteTooltip,
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
  weatherStore.onRemoteChange = refreshWeatherHeaders;

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
    calendarEl.addEventListener("click", (ev) => {
      const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".cb-weather-btn[data-date]");
      if (!btn) {
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      const date = btn.dataset.date || "";
      if (date) {
        openWeatherPicker(btn, date);
      }
    });
    // 双击新建的兜底：个别环境下第二次 dateClick 会被 FullCalendar 吞掉，用原生 dblclick 补判
    calendarEl.addEventListener("dblclick", (ev) => {
      if (Date.now() - lastCreateFromClick < 500 || Date.now() < suppressUntil) {
        return;
      }
      const last = lastEmptyClick;
      if (!last.date || Date.now() - last.time > 600) {
        return;
      }
      if (Math.abs(ev.clientX - last.x) > 8 || Math.abs(ev.clientY - last.y) > 8) {
        return;
      }
      if ((ev.target as HTMLElement | null)?.closest(".fc-event")) {
        return;
      }
      const { date, allDay } = last;
      lastEmptyClick = { time: 0, x: 0, y: 0, allDay: false, date: null };
      createAtPoint(date, allDay);
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && isDirty) {
      isDirty = false;
      refresh();
    }
  });
  window.addEventListener("focus", () => {
    if (isDirty) {
      isDirty = false;
      refresh();
    }
  });

  if (!storeReady) {
    showError(new Error("无法读取日程数据，请在思源中打开"));
  }
  store.startAutoRefresh(30000);
}

boot();
