import { Calendar, DateSelectArg, EventApi, EventClickArg, EventContentArg, EventDropArg, EventHoveringArg, EventInput, EventMountArg } from "@fullcalendar/core";
import zhCnLocale from "@fullcalendar/core/locales/zh-cn";
import html2canvas from "html2canvas";
import timeGridPlugin from "@fullcalendar/timegrid";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin, { DateClickArg, EventResizeDoneArg } from "@fullcalendar/interaction";
import { getBlockAttrs, setBlockAttrs, getDocTitle, getRootId } from "./api";
import { CalEvent, EventStore, RepeatScope } from "./store";
import {
  describeRepeat,
  eventStartDate,
  hasRepeat,
  instanceId,
  Occurrence,
  occurrenceDates,
  occurrencesInRange,
  parseInstanceId,
  RepeatRule,
  shiftStamp
} from "./repeat";
import { WeatherKind, WeatherStore, WEATHER_LABELS } from "./weather";
import { initThemeBridge } from "./theme";
import {
  closePopover,
  noRepeat,
  openPopover,
  PopoverValues,
  RepeatChoice,
  valuesToRange
} from "./popover";
import {
  DEFAULT_PALETTE,
  defaultColor,
  getPalette,
  isValidColor,
  loadPalette,
  onPaletteRemoteChange,
  savePalette
} from "./palette";
import { addMinutes, diffDays, fmtDate, fmtDateTime, fmtTime, addDaysStr, newEventId, textColorFor, parseDateFromTitle, getIsoWeek, parseDate, isoWeekStart, isValidDateStr, lunarDateLabel, mixColors } from "./util";
import "./widget.css";

type ViewKey = "day" | "week" | "month";
const VIEW_MAP: Record<ViewKey, string> = {
  day: "timeGridDay",
  week: "timeGridWeek",
  month: "dayGridMonth"
};
const VIEW_KEY: Record<string, ViewKey> = {
  timeGridDay: "day",
  timeGridWeek: "week",
  dayGridMonth: "month"
};
const PANEL_VIEWS: ViewKey[] = ["day", "week", "month"];
const PANEL_VIEW_LABELS: Record<ViewKey, string> = {
  day: "日视图",
  week: "周视图",
  month: "月视图"
};

const VIEW_ATTR = "custom-calendar-view";
const DATE_ATTR = "custom-calendar-date";
const DURATION_ATTR = "custom-calendar-default-duration";
// 完整显示 24 小时所需高度：时间网格 48 槽 × 24px = 1152px ＋ 表头/全天行/工具栏约 167px，再留余量
const DEFAULT_HEIGHT = "1330px";
const DEFAULT_DURATION_MINUTES = 30;
const DURATION_OPTIONS = [15, 30, 45, 60];
const LAST_COLOR_KEY = "schedule-block-last-color";
const PANEL_DURATION_KEY = "schedule-block-panel-default-duration";
const UI_CHANNEL = "schedule-block-ui";
const SNAP_MINUTES = 15;

const store = new EventStore();
const weatherStore = new WeatherStore();
let calendar: Calendar;
/** 事件 id → 当前已渲染的全部 DOM 片段；跨日事件会被 FullCalendar 拆成多个片段 */
const eventEls = new Map<string, Set<HTMLElement>>();
let blockId = "";
let docId = "";
let anchorDate = "";
let persistedViewKey: ViewKey | "" = "";
let defaultDurationMinutes = DEFAULT_DURATION_MINUTES;
let suppressUntil = 0;
let anchorEditor: { el: HTMLElement; dispose(): void } | null = null;
let weatherPicker: { el: HTMLElement; date: string; dispose(): void } | null = null;
let colorFilterPicker: { el: HTMLElement; dispose(): void } | null = null;
let scopeChooser: { el: HTMLElement; dispose(): void } | null = null;
let scopeCancelHook: (() => void) | null = null;
let noteTooltip: HTMLElement | null = null;
let noteTooltipDispose: (() => void) | null = null;
const visibleColors = new Set<string>(getPalette());
let searchKeyword = "";
let searchOpen = false;
let searchComposing = false;
/** 齿轮设置里颜色管理列表的重渲染回调（设置弹窗打开时有效） */
let colorManagerRerender: (() => void) | null = null;
let toolbarCreatePopoverOpen = false;
let panelMode = false;
let panelCurrentAnchor = fmtDate(new Date());
let lastClickedMoreLink: HTMLElement | null = null;
let interactionPrimeRaf = 0;
let eventColorRefreshTimer = 0;

function lastColor(): string {
  try {
    const saved = localStorage.getItem(LAST_COLOR_KEY);
    // 上次用色若已从取色板移除，回退到取色板首色
    if (saved && getPalette().includes(saved)) {
      return saved;
    }
    return defaultColor();
  } catch {
    return defaultColor();
  }
}

function colorSoft(color: string, alpha = 0.18): string {
  const hex = color.replace("#", "");
  if (hex.length !== 6) {
    return "rgba(75, 85, 99, 0.18)";
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function syncCreateColor(color = lastColor()): void {
  document.documentElement.style.setProperty("--cb-create-color", color);
  document.documentElement.style.setProperty("--cb-create-color-soft", colorSoft(color));
  document.documentElement.style.setProperty("--cb-create-color-on", textColorFor(color));
  if (calendar) {
    calendar.setOption("eventBackgroundColor", color);
    calendar.setOption("eventBorderColor", "transparent");
    calendar.setOption("eventTextColor", textColorFor(color));
  }
}

function rememberColor(color: string): void {
  try {
    localStorage.setItem(LAST_COLOR_KEY, color);
  } catch {
    // 忽略
  }
  syncCreateColor(color);
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

function normalizeDurationOption(minutes: number): number {
  return DURATION_OPTIONS.includes(minutes) ? minutes : DEFAULT_DURATION_MINUTES;
}

function loadPanelDefaultDuration(): number {
  try {
    return normalizeDurationOption(parseDurationMinutes(localStorage.getItem(PANEL_DURATION_KEY)));
  } catch {
    return DEFAULT_DURATION_MINUTES;
  }
}

function savePanelDefaultDuration(minutes: number): void {
  defaultDurationMinutes = normalizeDurationOption(parseDurationMinutes(String(minutes)));
  try {
    localStorage.setItem(PANEL_DURATION_KEY, String(defaultDurationMinutes));
  } catch {
    // 忽略
  }
  calendar?.setOption("defaultTimedEventDuration", durationToFullCalendar(defaultDurationMinutes));
}

function isQuickAddShortcut(event: KeyboardEvent): boolean {
  return !event.metaKey
    && !event.altKey
    && !event.ctrlKey
    && !event.shiftKey
    && event.key.toLowerCase() === "s";
}

function postUiMessage(message: Record<string, unknown>): void {
  try {
    const channel = new BroadcastChannel(UI_CHANNEL);
    channel.postMessage(message);
    channel.close();
  } catch {
    // BroadcastChannel 不可用时忽略
  }
}

function installQuickAddShortcutBridge(): void {
  window.addEventListener("keydown", (event) => {
    if (isEditableTarget(event.target)) return;
    if (!isQuickAddShortcut(event)) return;
    event.preventDefault();
    event.stopPropagation();
    postUiMessage({ type: "quickadd-open" });
  }, true);
}

function eventDurationMinutes(event: EventApi): number {
  if (event.allDay || !event.start || !event.end) {
    return 0;
  }
  return Math.max(Math.round((event.end.getTime() - event.start.getTime()) / 60000), 0);
}

function compactClock(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function eventSegmentTimeText(arg: EventContentArg): string {
  if (arg.event.allDay || !arg.event.start || !arg.event.end) {
    return arg.timeText;
  }
  if (arg.isStart && arg.isEnd) {
    return `${compactClock(arg.event.start)}-${compactClock(arg.event.end)}`;
  }
  if (arg.isStart) {
    return `${compactClock(arg.event.start)}-`;
  }
  if (arg.isEnd) {
    return `-${compactClock(arg.event.end)}`;
  }
  return "";
}

function monthLunarLabel(d: Date): string {
  const label = lunarDateLabel(d);
  if (!label) {
    return "";
  }
  if (label.endsWith("初一")) {
    return label.slice(0, -2);
  }
  return label.replace(/^.*月/, "");
}

function durationBadge(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) {
    return `(${h}h${m}m)`;
  }
  if (h) {
    return `(${h}h)`;
  }
  return `(${m}m)`;
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
  // 事件块可见配色来自 CSS 变量，而 setProp 不会重跑 eventDidMount，
  // 因此必须直接把新配色写到当前已渲染的元素上，颜色才会即时变化。
  const els = eventEls.get(event.id);
  if (els) {
    for (const el of els) {
      applyEventColorVars(el, color);
    }
  }
}

/** 把某个配色对应的 CSS 变量写到事件块元素上（widget.css 用这些变量+!important 决定可见色） */
function applyEventColorVars(el: HTMLElement, color: string): void {
  const isDark = document.documentElement.getAttribute("data-theme-mode") === "dark";
  const themeBgVar = getComputedStyle(document.documentElement).getPropertyValue("--b3-theme-background").trim();
  const themeBg = themeBgVar || (isDark ? "#1b1b1f" : "#ffffff");
  const themeOnBgVar = getComputedStyle(document.documentElement).getPropertyValue("--b3-theme-on-background").trim();
  const themeOnBg = themeOnBgVar || (isDark ? "#ffffff" : "#1f2329");
  const bgWeight = isDark ? 0.16 : 0.12;
  const hoverWeight = isDark ? 0.25 : 0.20;
  el.style.setProperty("--cb-event-color", color);
  el.style.setProperty("--cb-event-bg-color", mixColors(color, themeBg, bgWeight));
  el.style.setProperty("--cb-event-hover-bg-color", mixColors(color, themeBg, hoverWeight));
  el.style.setProperty("--cb-event-text-color", themeOnBg);
}

function refreshRenderedEventColors(): void {
  window.clearTimeout(eventColorRefreshTimer);
  eventColorRefreshTimer = window.setTimeout(() => {
    for (const [eventId, els] of eventEls) {
      const event = calendar?.getEventById(eventId);
      for (const el of els) {
        const color = String(event?.backgroundColor || el.style.getPropertyValue("--cb-event-color") || lastColor());
        applyEventColorVars(el, color);
        scheduleAdjustEventDuration(el);
      }
    }
  }, 0);
}

function applyValuesToEvent(event: EventApi, values: PopoverValues): void {
  const range = valuesToRange(values);
  event.setProp("title", values.title || "（无标题）");
  applyEventColor(event, values.color);
  event.setDates(range.start, range.end, { allDay: range.allDay });
  event.setExtendedProp("isTodo", values.isTodo);
  if (!values.isTodo) {
    event.setExtendedProp("done", false);
  }
}

function toFC(occ: Occurrence): EventInput {
  const event = occ.event;
  return {
    id: instanceId(event.id, occ.date, occ.repeating),
    title: event.title,
    start: occ.start,
    end: occ.end,
    allDay: event.allDay,
    backgroundColor: event.color,
    borderColor: "transparent",
    textColor: textColorFor(event.color),
    extendedProps: {
      isTodo: Boolean(event.isTodo),
      done: occ.done,
      repeating: occ.repeating,
      eventId: event.id,
      occurrenceDate: occ.date
    }
  };
}

/** 当前视图范围内的全部实例 */
function occurrencesForRange(rangeStart: string, rangeEnd: string): Occurrence[] {
  const out: Occurrence[] = [];
  for (const event of visibleFilteredEvents()) {
    out.push(...occurrencesInRange(event, rangeStart, rangeEnd));
  }
  return out;
}

function eventClassNames(arg: { event: EventApi }): string[] {
  const isTodo = Boolean(arg.event.extendedProps.isTodo);
  const done = Boolean(arg.event.extendedProps.done);
  const names: string[] = [];
  if (arg.event.extendedProps.repeating) {
    names.push("cb-event--repeat");
  }
  if (isTodo) {
    names.push(done ? "cb-event--todo-done" : "cb-event--todo");
  }
  return names;
}

/** 重复日程的标记：循环箭头，跟在标题后面 */
function repeatMarker(): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "cb-event-repeat";
  mark.setAttribute("aria-label", "重复日程");
  mark.setAttribute("title", "重复日程");
  mark.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M7 7h9V4.5L20.5 8L16 11.5V9H8v3.2L6 10.4V8a1 1 0 0 1 1-1Zm10 10H8v2.5L3.5 16L8 12.5V15h8v-3.2l2 1.8V16a1 1 0 0 1-1 1Z"/></svg>`;
  return mark;
}

function renderEventContent(arg: EventContentArg): { domNodes: Node[] } {
  const isTodo = Boolean(arg.event.extendedProps.isTodo);
  const done = Boolean(arg.event.extendedProps.done);
  const wrap = document.createElement("div");
  wrap.className = "cb-event-inner";

  if (currentViewKey() === "month") {
    wrap.classList.add("cb-month-event-inner");
    if (isTodo) {
      wrap.classList.add("cb-month-event-inner--todo");
    }
    const marker = document.createElement("span");
    marker.className = "cb-month-event-marker";
    marker.style.backgroundColor = String(arg.event.backgroundColor || lastColor());
    wrap.appendChild(marker);

    if (isTodo) {
      const check = document.createElement("button");
      check.type = "button";
      check.className = "cb-event-check";
      check.dataset.eventId = arg.event.id;
      check.setAttribute("aria-label", done ? "标记为未完成" : "标记为已完成");
      check.setAttribute("title", done ? "标记为未完成" : "标记为已完成");
      check.setAttribute("aria-pressed", done ? "true" : "false");
      wrap.appendChild(check);
    }

    const title = document.createElement("span");
    title.className = "cb-event-title";
    title.textContent = arg.event.title || "（无标题）";
    wrap.appendChild(title);
    if (arg.event.extendedProps.repeating) {
      wrap.appendChild(repeatMarker());
    }

    if (arg.event.start && !arg.event.allDay) {
      const time = document.createElement("span");
      time.className = "cb-event-time";
      time.textContent = compactClock(arg.event.start);
      wrap.appendChild(time);
    }
    return { domNodes: [wrap] };
  }

  if (isTodo) {
    const check = document.createElement("button");
    check.type = "button";
    check.className = "cb-event-check";
    check.dataset.eventId = arg.event.id;
    check.setAttribute("aria-label", done ? "标记为未完成" : "标记为已完成");
    check.setAttribute("title", done ? "标记为未完成" : "标记为已完成");
    check.setAttribute("aria-pressed", done ? "true" : "false");
    wrap.appendChild(check);
  }

  const body = document.createElement("span");
  body.className = "cb-event-body";
  const timeText = eventSegmentTimeText(arg);
  if (timeText) {
    const time = document.createElement("span");
    time.className = "cb-event-time";
    time.textContent = timeText;
    body.appendChild(time);
  }
  const title = document.createElement("span");
  title.className = "cb-event-title";
  title.textContent = arg.event.title || "（无标题）";
  if (arg.event.extendedProps.repeating) {
    const titleLine = document.createElement("span");
    titleLine.className = "cb-event-title-line";
    titleLine.append(title, repeatMarker());
    body.appendChild(titleLine);
  } else {
    body.appendChild(title);
  }
  const minutes = eventDurationMinutes(arg.event);
  if (minutes > 45) {
    const duration = document.createElement("span");
    duration.className = "cb-event-duration";
    duration.textContent = durationBadge(minutes);
    body.appendChild(duration);
  }
  wrap.appendChild(body);

  return { domNodes: [wrap] };
}

function onEventDidMount(arg: EventMountArg): void {
  const color = String(arg.event.backgroundColor || lastColor());
  applyEventColorVars(arg.el, color);
  let els = eventEls.get(arg.event.id);
  if (!els) {
    els = new Set<HTMLElement>();
    eventEls.set(arg.event.id, els);
  }
  els.add(arg.el);
  scheduleAdjustEventDuration(arg.el);
}

function onEventWillUnmount(arg: EventMountArg): void {
  const els = eventEls.get(arg.event.id);
  if (!els) {
    return;
  }
  els.delete(arg.el);
  if (els.size === 0) {
    eventEls.delete(arg.event.id);
  }
}

function scheduleAdjustEventDuration(el: HTMLElement): void {
  window.requestAnimationFrame(() => {
    adjustEventDurationVisibility(el);
  });
}

function adjustMorePopover(): void {
  const popover = document.querySelector<HTMLElement>(".fc-popover");
  if (!popover) {
    return;
  }
  const margin = 10;
  const body = popover.querySelector<HTMLElement>(".fc-popover-body");
  const cell = lastClickedMoreLink?.closest<HTMLElement>(".fc-daygrid-day");
  
  if (cell && body) {
    const cellRect = cell.getBoundingClientRect();
    const headerHeight = 26; // Height of the cell's date/lunar header
    
    // 1. Measure popover non-body height (borders, padding, header)
    body.style.maxHeight = "9999px";
    let _reflow = popover.offsetHeight;
    let popoverRect = popover.getBoundingClientRect();
    let bodyRect = body.getBoundingClientRect();
    const nonBodyHeight = Math.max(0, popoverRect.height - bodyRect.height);
    
    // 2. Enforce viewport containment on height
    const maxPopoverHeight = window.innerHeight - 2 * margin;
    const maxBodyHeight = maxPopoverHeight - nonBodyHeight;
    body.style.maxHeight = `${Math.max(120, maxBodyHeight)}px`;
    
    // Force layout reflow after setting height limit
    _reflow = popover.offsetHeight;
    popoverRect = popover.getBoundingClientRect();
    
    // 3. Position: default is below the cell's native header
    let desiredViewportTop = cellRect.top + headerHeight;
    
    // Shift upward if it overflows the bottom
    if (desiredViewportTop + popoverRect.height > window.innerHeight - margin) {
      desiredViewportTop = window.innerHeight - popoverRect.height - margin;
    }
    
    // Ensure it doesn't go above the top margin
    if (desiredViewportTop < margin) {
      desiredViewportTop = margin;
    }
    
    // 4. Dynamically show/hide the popover title based on whether the cell's native header is covered
    const titleEl = popover.querySelector<HTMLElement>(".fc-popover-title");
    if (titleEl) {
      if (desiredViewportTop < cellRect.top + headerHeight) {
        titleEl.style.display = ""; // Show title (covers native header)
      } else {
        titleEl.style.display = "none"; // Hide title (native header is visible)
      }
    }
    
    // 5. Apply the calculated vertical position
    const topDelta = desiredViewportTop - popoverRect.top;
    if (Math.abs(topDelta) > 0.5) {
      const currentTop = Number.parseFloat(popover.style.top || "0");
      const baseTop = Number.isFinite(currentTop) ? currentTop : 0;
      popover.style.top = `${Math.max(0, baseTop + topDelta)}px`;
    }
  } else {
    // Fallback if cell or body is missing
    if (body) {
      body.style.maxHeight = `${Math.max(140, Math.round(window.innerHeight * 0.56))}px`;
    }
    const rect = popover.getBoundingClientRect();
    const maxViewportTop = Math.max(margin, window.innerHeight - rect.height - margin);
    let desiredViewportTop = Math.min(Math.max(rect.top, margin), maxViewportTop);
    
    const topDelta = desiredViewportTop - rect.top;
    if (Math.abs(topDelta) > 0.5) {
      const currentTop = Number.parseFloat(popover.style.top || "0");
      const baseTop = Number.isFinite(currentTop) ? currentTop : 0;
      popover.style.top = `${Math.max(0, baseTop + topDelta)}px`;
    }
  }

  // Adjust left position
  const nextRect = popover.getBoundingClientRect();
  const maxViewportLeft = Math.max(margin, window.innerWidth - nextRect.width - margin);
  const desiredViewportLeft = Math.min(Math.max(nextRect.left, margin), maxViewportLeft);
  const leftDelta = desiredViewportLeft - nextRect.left;
  if (Math.abs(leftDelta) > 0.5) {
    const currentLeft = Number.parseFloat(popover.style.left || "0");
    const baseLeft = Number.isFinite(currentLeft) ? currentLeft : 0;
    popover.style.left = `${Math.max(0, baseLeft + leftDelta)}px`;
  }

  // Final safety check to make sure it doesn't overflow the viewport bottom
  const finalRect = popover.getBoundingClientRect();
  if (body && finalRect.bottom > window.innerHeight - margin) {
    const available = Math.max(120, window.innerHeight - Math.max(finalRect.top, margin) - margin - 36);
    body.style.maxHeight = `${available}px`;
  }
}

function scheduleAdjustMorePopover(): void {
  window.requestAnimationFrame(() => window.requestAnimationFrame(adjustMorePopover));
}

function adjustAllEventDurations(): void {
  document.querySelectorAll<HTMLElement>(".cb-calendar .fc-event").forEach(adjustEventDurationVisibility);
}

function adjustEventDurationVisibility(el: HTMLElement): void {
  const duration = el.querySelector<HTMLElement>(".cb-event-duration");
  if (!duration) {
    return;
  }
  duration.hidden = false;
  const title = el.querySelector<HTMLElement>(".cb-event-title");
  const body = el.querySelector<HTMLElement>(".cb-event-body");
  const main = el.querySelector<HTMLElement>(".fc-event-main") || el;
  if (!title || !body) {
    duration.hidden = true;
    return;
  }
  const bodyOverflows = body.scrollHeight > body.clientHeight + 1 || main.scrollHeight > main.clientHeight + 1;
  duration.hidden = bodyOverflows || el.classList.contains("fc-timegrid-event-short");
}

function isColorFilterAll(): boolean {
  const palette = getPalette();
  return visibleColors.size === palette.length && palette.every((c) => visibleColors.has(c));
}

function visibleFilteredEvents(): CalEvent[] {
  let events = store.visibleEvents();
  if (!isColorFilterAll()) {
    events = events.filter((event) => visibleColors.has(event.color));
  }
  const kw = searchKeyword.trim().toLowerCase();
  if (!kw) {
    return events;
  }
  return events.filter((event) => eventMatchesKeyword(event, kw));
}

function eventMatchesKeyword(event: CalEvent, keyword: string): boolean {
  const haystack = `${event.title || ""}\n${event.note || ""}`.toLowerCase();
  return haystack.includes(keyword);
}

function syncColorFilterButton(root: HTMLElement): void {
  const btn = root.querySelector(".cb-btn-filter") as HTMLElement | null;
  if (btn) {
    btn.classList.toggle("cb-icon-btn--active", !isColorFilterAll());
  }
}

function syncSearchButton(root: HTMLElement): void {
  const btn = root.querySelector(".cb-btn-search") as HTMLElement | null;
  if (btn) {
    btn.classList.toggle("cb-icon-btn--active", searchOpen || Boolean(searchKeyword.trim()));
  }
  const box = root.querySelector(".cb-toolbar-search") as HTMLElement | null;
  if (box) {
    box.classList.toggle("cb-toolbar-search--open", searchOpen || Boolean(searchKeyword.trim()));
  }
  const input = root.querySelector(".cb-search-input") as HTMLInputElement | null;
  if (input && input.value !== searchKeyword) {
    input.value = searchKeyword;
  }
  const clearBtn = root.querySelector(".cb-search-clear") as HTMLButtonElement | null;
  if (clearBtn) {
    clearBtn.hidden = !searchKeyword.trim();
  }
}

function selectAllColors(): void {
  visibleColors.clear();
  for (const color of getPalette()) {
    visibleColors.add(color);
  }
}

/** 取色板变动后：筛选重置为全部、同步筛选按钮与列表、刷新日历 */
function applyPaletteChanged(): void {
  selectAllColors();
  syncCreateColor();
  const root = document.getElementById("app");
  if (root) {
    syncColorFilterButton(root);
  }
  syncColorFilterPicker();
  colorManagerRerender?.();
  refresh();
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
      note: event.note,
      isTodo: Boolean(event.isTodo),
      repeat: noRepeat(event.start)
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
    note: event.note,
    isTodo: Boolean(event.isTodo),
    repeat: noRepeat(sd)
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
  // 快捷添加弹窗没有日历实例
  if (!calendar) {
    return;
  }
  calendar.refetchEvents();
  scheduleSyncCalendarScrollbars();
}

/** 该事件在当前文档归属与颜色筛选下是否应显示在日历上 */
function isCalendarEventVisible(ev: CalEvent): boolean {
  if (!store.visibleEvents().some((e) => e.id === ev.id)) {
    return false;
  }
  const kw = searchKeyword.trim().toLowerCase();
  return (isColorFilterAll() || visibleColors.has(ev.color)) && (!kw || eventMatchesKeyword(ev, kw));
}

/**
 * 仅增量同步单个事件到日历视图：移除旧节点后按需重新加入。
 * 用于新建/编辑/删除/勾选等单事件改动，避免 refetchEvents() 整表重建
 * 导致所有事件块同时重绘而闪烁。
 */
function syncCalendarEvent(id: string): void {
  if (!calendar) {
    return;
  }
  const { eventId } = parseInstanceId(id);
  calendar.getEventById(id)?.remove();
  const ev = store.get(eventId);
  if (ev && isCalendarEventVisible(ev)) {
    const view = calendar.view;
    const [occ] = occurrencesInRange(ev, fmtDate(view.activeStart), fmtDate(view.activeEnd));
    if (occ) {
      const [source] = calendar.getEventSources();
      calendar.addEvent(toFC(occ), source ?? undefined);
    }
  }
  scheduleSyncCalendarScrollbars();
}

/**
 * 改动落盘后刷新视图：普通日程走增量同步（不闪），
 * 重复日程一次改动会牵动多个实例，只能整表重取。
 */
function syncAfterChange(event: CalEvent | undefined, instance?: string): void {
  if (!event || hasRepeat(event)) {
    refresh();
    return;
  }
  syncCalendarEvent(instance || event.id);
}

function scheduleSyncCalendarScrollbars(): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      syncCalendarScrollbars();
      adjustAllEventDurations();
    });
  });
}

function syncCalendarScrollbars(): void {
  const root = document.querySelector(".cb-calendar") as HTMLElement | null;
  if (!root) {
    return;
  }
  if (currentViewKey() === "month") {
    root.querySelectorAll<HTMLElement>(".fc-scroller").forEach((scroller) => {
      scroller.style.overflowY = "";
    });
    return;
  }
  const bodyScroller = root.querySelector<HTMLElement>(".fc-scroller-liquid-absolute");
  root.querySelectorAll<HTMLElement>(".fc-scroller").forEach((scroller) => {
    if (scroller !== bodyScroller) {
      scroller.style.overflowY = "hidden";
    }
  });
  if (!bodyScroller) {
    return;
  }
  const slots = root.querySelector<HTMLElement>(".fc-timegrid-slots");
  const requiredHeight = slots?.scrollHeight || slots?.getBoundingClientRect().height || 0;
  const availableHeight = bodyScroller.clientHeight;
  const fitsFullDay = requiredHeight > 0 && availableHeight + 2 >= requiredHeight;
  bodyScroller.style.overflowY = fitsFullDay ? "hidden" : "auto";
  if (fitsFullDay) {
    bodyScroller.scrollTop = 0;
  }
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

function showNoteTooltipFor(id: string, el: HTMLElement, point: { x: number; y: number } | null): void {
  const note = store.get(id)?.note.trim();
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
  el.addEventListener("mousemove", move);
  noteTooltipDispose = () => el.removeEventListener("mousemove", move);

  if (point) {
    positionNoteTooltip(point.x, point.y);
  } else {
    const rect = el.getBoundingClientRect();
    positionNoteTooltip(rect.right, rect.top);
  }
}

function showEventNoteTooltip(info: EventHoveringArg): void {
  const jsEvent = info.jsEvent;
  showNoteTooltipFor(info.event.id, info.el, jsEvent ? { x: jsEvent.clientX, y: jsEvent.clientY } : null);
}

/* ---------- 重复日程 ---------- */

/** 弹窗取值 → 存储规则；不重复时返回 undefined */
function ruleFromValues(values: PopoverValues): RepeatRule | undefined {
  const choice = values.repeat;
  if (!choice || choice.freq === "none") {
    return undefined;
  }
  const rule: RepeatRule = { freq: choice.freq };
  if (choice.end === "count") {
    rule.count = Math.max(2, Math.round(choice.count));
  } else if (choice.end === "until" && isValidDateStr(choice.until)) {
    rule.until = choice.until;
  }
  return rule;
}

/** 存储规则 → 弹窗取值 */
function choiceFromRule(event: CalEvent): RepeatChoice {
  const base = noRepeat(event.start.split("T")[0]);
  const rule = event.repeat;
  if (!rule) {
    return base;
  }
  return {
    freq: rule.freq,
    end: rule.count ? "count" : rule.until ? "until" : "never",
    count: rule.count || base.count,
    until: rule.until || base.until
  };
}

/**
 * 整串修改时，把某一次实例的新时间折算回系列主事件：
 * 日期按这一次挪动的天数平移，时刻与时长直接取新值。
 */
function seriesShiftPatch(event: CalEvent, occDate: string, start: string, end: string): { start: string; end: string } {
  const newStartDate = start.split("T")[0];
  const shiftDays = diffDays(occDate || eventStartDate(event), newStartDate);
  const baseStartDate = shiftStamp(event.start, shiftDays).split("T")[0];
  const spanDays = Math.max(diffDays(newStartDate, end.split("T")[0]), 0);
  const startTime = start.includes("T") ? start.split("T")[1] : "";
  const endTime = end.includes("T") ? end.split("T")[1] : "";
  const endDate = addDaysStr(baseStartDate, spanDays);
  return {
    start: startTime ? `${baseStartDate}T${startTime}` : baseStartDate,
    end: endTime ? `${endDate}T${endTime}` : endDate
  };
}

/** 打开"改动范围"选择条：仅此日程 / 此后所有 / 全部日程 */
function chooseRepeatScope(anchor: { x: number; y: number }, kind: "edit" | "delete", onPick: (scope: RepeatScope) => void, onCancel?: () => void): void {
  closeScopeChooser();
  const el = document.createElement("div");
  el.className = "cb-scope-chooser";
  el.setAttribute("role", "dialog");
  el.innerHTML = `
    <div class="cb-scope-title">${kind === "delete" ? "删除重复日程" : "更改重复日程"}</div>
    <button type="button" class="cb-scope-item" data-scope="this">仅此日程</button>
    <button type="button" class="cb-scope-item" data-scope="following">此后所有日程</button>
    <button type="button" class="cb-scope-item" data-scope="all">全部日程</button>
    <button type="button" class="cb-scope-cancel">取消</button>
  `;
  document.body.appendChild(el);
  const margin = 8;
  const rect = el.getBoundingClientRect();
  el.style.left = `${Math.min(Math.max(anchor.x, margin), Math.max(window.innerWidth - rect.width - margin, margin))}px`;
  el.style.top = `${Math.min(Math.max(anchor.y, margin), Math.max(window.innerHeight - rect.height - margin, margin))}px`;

  el.querySelectorAll<HTMLButtonElement>("[data-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const scope = (btn.dataset.scope || "this") as RepeatScope;
      closeScopeChooser();
      onPick(scope);
    });
  });
  let picked = false;
  el.querySelectorAll<HTMLButtonElement>("[data-scope]").forEach((btn) => {
    btn.addEventListener("click", () => {
      picked = true;
    });
  });
  el.querySelector(".cb-scope-cancel")!.addEventListener("click", () => closeScopeChooser());
  scopeCancelHook = () => {
    if (!picked) {
      onCancel?.();
    }
  };

  const onOutside = (event: MouseEvent) => {
    if (!el.contains(event.target as Node)) {
      closeScopeChooser();
    }
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeScopeChooser();
    }
  };
  const timer = window.setTimeout(() => {
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey, true);
  }, 0);
  scopeChooser = {
    el,
    dispose: () => {
      window.clearTimeout(timer);
      document.removeEventListener("mousedown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
    }
  };
}

function closeScopeChooser(): void {
  if (!scopeChooser) {
    return;
  }
  const { el, dispose } = scopeChooser;
  scopeChooser = null;
  dispose();
  el.remove();
  const hook = scopeCancelHook;
  scopeCancelHook = null;
  hook?.();
}

async function toggleTodoDone(instance: string): Promise<void> {
  const { eventId, date } = parseInstanceId(instance);
  const stored = store.get(eventId);
  if (!stored || !stored.isTodo) {
    return;
  }
  await store.toggleDone(eventId, date);
  syncAfterChange(stored);
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
    note: "",
    isTodo: false,
    repeat: noRepeat(fmtDate(info.start))
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
        docId: "",
        isTodo: v.isTodo,
        done: false,
        repeat: ruleFromValues(v)
      });
    } else {
      await store.update(draftSavedId, {
        title: v.title,
        start: range.start,
        end: range.end,
        allDay: range.allDay,
        color: v.color,
        note: v.note,
        isTodo: v.isTodo,
        done: v.isTodo ? Boolean(store.get(draftSavedId)?.done) : false,
        repeat: ruleFromValues(v)
      });
    }
    if (close) {
      draft?.remove();
      syncAfterChange(store.get(draftSavedId), draftSavedId);
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
        store.remove(draftSavedId).then(() => syncCalendarEvent(draftSavedId)).catch(showError);
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

function isMonthDateDrillTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return Boolean(el?.closest(".fc-daygrid-day-number,.fc-daygrid-day-top"));
}

function onDateClick(info: DateClickArg): void {
  if (Date.now() < suppressUntil) {
    return;
  }
  if (panelMode && currentViewKey() === "month" && isMonthDateDrillTarget(info.jsEvent?.target || null)) {
    switchPanelView("day", info.date);
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
  createAtPoint(info.date, currentViewKey() === "month" ? true : info.allDay);
}

/** 编辑弹窗打开期间，把改动实时映射到视图上（纵向作用于 FullCalendar 事件，横向作用于渲染覆盖层） */
interface PreviewHandle {
  setTitle(title: string): void;
  setColor(color: string): void;
  setValues(values: PopoverValues): void;
  restore(original: CalEvent): void;
}

function fcPreview(event: EventApi): PreviewHandle {
  return {
    setTitle: (title) => event.setProp("title", title),
    setColor: (color) => applyEventColor(event, color),
    setValues: (values) => applyValuesToEvent(event, values),
    restore: (original) => {
      event.setProp("title", original.title);
      applyEventColor(event, original.color);
    }
  };
}

function onEventClick(info: EventClickArg): void {
  info.jsEvent.preventDefault();
  if ((info.jsEvent.target as HTMLElement | null)?.closest(".cb-event-check")) {
    return;
  }
  openEventEditor(info.event.id, {
    x: info.jsEvent.clientX,
    y: info.jsEvent.clientY,
    rect: info.el.getBoundingClientRect()
  }, fcPreview(info.event));
}

/**
 * 打开编辑弹窗。
 * 普通日程沿用"边改边存、点外部保留"的老习惯；
 * 重复日程必须显式点保存并选择改动范围（仅此 / 此后所有 / 全部），点外部或 Esc 视为放弃。
 */
function openEventEditor(instance: string, anchor: { x: number; y: number; rect?: DOMRect }, preview: PreviewHandle): void {
  hideEventNoteTooltip();
  const { eventId, date } = parseInstanceId(instance);
  const stored = store.get(eventId);
  if (!stored) {
    return;
  }
  const repeating = hasRepeat(stored);
  const [occurrence] = repeating
    ? occurrencesInRange(stored, date, addDaysStr(date, 1))
    : [];
  const shownStart = occurrence ? occurrence.start : stored.start;
  const shownEnd = occurrence ? occurrence.end : stored.end;
  const original = { ...stored };
  let editInteracted = false;
  let latestEditValues = eventToValues({ ...stored, start: shownStart, end: shownEnd });
  const initialChoice = choiceFromRule(stored);
  latestEditValues.repeat = { ...initialChoice };
  let editSaveTimer = 0;

  /** 把弹窗取值折算成对存储的改动；重复日程按实例的位移整体平移 */
  const patchFromValues = (v: PopoverValues, scope: RepeatScope): Partial<CalEvent> => {
    const range = valuesToRange(v);
    const patch: Partial<CalEvent> = {
      title: v.title,
      color: v.color,
      note: v.note,
      isTodo: v.isTodo,
      allDay: range.allDay
    };
    if (!repeating || scope !== "all") {
      patch.start = range.start;
      patch.end = range.end;
      patch.repeat = scope === "this" ? undefined : ruleFromValues(v);
      // "此后所有"另开一条系列：用户没改结束条件时，把剩余次数带过去，
      // 否则新系列会平白多出几次
      if (scope === "following" && patch.repeat?.count) {
        const untouched = v.repeat.end === initialChoice.end
          && v.repeat.count === initialChoice.count
          && v.repeat.until === initialChoice.until;
        if (untouched) {
          const remaining = occurrenceDates(stored).filter((d) => d >= date).length;
          patch.repeat = { ...patch.repeat, count: Math.max(remaining, 2) };
        }
      }
      return patch;
    }
    // 整串修改：把这一次挪动的天数平移回主事件，保持系列锚点
    Object.assign(patch, seriesShiftPatch(stored, date, range.start, range.end));
    patch.repeat = ruleFromValues(v);
    return patch;
  };

  const applyEdit = async (v: PopoverValues, scope: RepeatScope) => {
    rememberColor(v.color);
    const patch = patchFromValues(v, scope);
    if (!repeating) {
      await store.update(stored.id, { ...patch, done: v.isTodo ? Boolean(stored.done) : false });
    } else {
      await store.updateOccurrence(stored.id, date, scope, patch, newEventId);
    }
    preview.restore(original);
    refresh();
  };

  /** 普通日程的即时保存（重复日程不走这条路） */
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
      note: v.note,
      isTodo: v.isTodo,
      done: v.isTodo ? Boolean(stored.done) : false,
      repeat: ruleFromValues(v)
    });
  };

  const queueEditSave = (v: PopoverValues) => {
    editInteracted = true;
    latestEditValues = v;
    preview.setValues(v);
    if (repeating) {
      // 重复日程要等用户选范围，改动先只做预览
      return;
    }
    window.clearTimeout(editSaveTimer);
    editSaveTimer = window.setTimeout(() => {
      persistEdit(latestEditValues).catch(showError);
    }, 500);
  };

  openPopover({
    mode: "edit",
    anchor,
    values: latestEditValues,
    repeatHint: repeating ? describeRepeat(stored) : "",
    onTitleChange: (title) => {
      preview.setTitle(title);
    },
    onColorChange: (color) => {
      preview.setColor(color);
    },
    onValuesChange: queueEditSave,
    onSave: async (v) => {
      window.clearTimeout(editSaveTimer);
      if (!repeating) {
        await persistEdit(v).catch(showError);
        preview.restore(original);
        syncAfterChange(store.get(stored.id), instance);
        return;
      }
      // 规则本身变了就没必要问范围：新规则天然作用于整串
      chooseRepeatScope(anchor, "edit", (scope) => {
        applyEdit(v, scope).catch(showError);
      });
    },
    onDelete: () => {
      window.clearTimeout(editSaveTimer);
      if (!repeating) {
        preview.restore(original);
        store.remove(stored.id).then(() => syncCalendarEvent(instance)).catch(showError);
        return;
      }
      chooseRepeatScope(anchor, "delete", (scope) => {
        preview.restore(original);
        store.removeOccurrence(stored.id, date, scope).then(refresh).catch(showError);
      });
    },
    onClose: () => {
      window.clearTimeout(editSaveTimer);
      if (repeating) {
        // 重复日程未点保存即视为放弃
        preview.restore(original);
        return;
      }
      if (editInteracted) {
        persistEdit(latestEditValues)
          .then(() => {
            preview.restore(original);
            syncAfterChange(store.get(stored.id), instance);
          })
          .catch(showError);
      } else {
        preview.restore(original);
      }
    },
    onCancel: () => {
      window.clearTimeout(editSaveTimer);
      preview.restore(original);
      if (repeating || !editInteracted) {
        refresh();
        return;
      }
      // 回滚到打开弹窗前的原始内容
      store.update(stored.id, {
        title: original.title,
        start: original.start,
        end: original.end,
        allDay: original.allDay,
        color: original.color,
        note: original.note,
        isTodo: Boolean(original.isTodo),
        done: Boolean(original.done),
        repeat: original.repeat
      }).then(() => syncAfterChange(store.get(stored.id), instance)).catch(showError);
    }
  });
}

async function onEventMutate(info: EventDropArg | EventResizeDoneArg): Promise<void> {
  closePopover(true);
  hideEventNoteTooltip();
  const event = info.event;
  const { eventId, date } = parseInstanceId(event.id);
  const stored = store.get(eventId);
  if (!stored) {
    return;
  }
  const range = serializeRange({ start: event.start, end: event.end, allDay: event.allDay });
  if (!hasRepeat(stored)) {
    try {
      await store.update(eventId, { start: range.start, end: range.end, allDay: event.allDay });
    } catch (err) {
      info.revert();
      showError(err);
    }
    return;
  }
  // 拖动的是重复日程的某一次，先问改动范围
  const jsEvent = info.jsEvent as MouseEvent | undefined;
  const rect = info.el.getBoundingClientRect();
  const anchor = { x: jsEvent?.clientX ?? rect.left, y: jsEvent?.clientY ?? rect.bottom };
  chooseRepeatScope(anchor, "edit", (scope) => {
    const patch: Partial<CalEvent> = scope === "all"
      ? { ...seriesShiftPatch(stored, date, range.start, range.end), allDay: event.allDay }
      : { start: range.start, end: range.end, allDay: event.allDay };
    if (scope === "this") {
      patch.repeat = undefined;
    }
    store.updateOccurrence(stored.id, date, scope, patch, newEventId)
      .then(refresh)
      .catch((err) => {
        info.revert();
        showError(err);
      });
  }, () => info.revert());
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

/** 当前视图起始日 */
function currentStartDate(): string {
  return calendar ? fmtDate(calendar.view.currentStart) : anchorDate;
}

function viewGotoDate(date: string): void {
  calendar?.gotoDate(date);
}

function viewStep(days: number): void {
  if (days < 0) {
    calendar.prev();
  } else {
    calendar.next();
  }
}

function anchorLabel(view: ViewKey): string {
  if (!anchorDate) {
    return "";
  }
  if (view === "week") {
    const d = parseDate(anchorDate);
    const iso = getIsoWeek(d);
    const m = iso.match(/^(\d{4})-W(\d{2})$/);
    if (m) {
      return `${m[1]}年第${parseInt(m[2], 10)}周`;
    }
    return iso;
  }
  if (view === "month") {
    const d = parseDate(anchorDate);
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  }
  return anchorDate;
}

/** 按钮上显示的是"当前正在看的那一天/周/月"，而不是绑定值；是否等于绑定值由高亮样式表达 */
function visibleLabel(view: ViewKey): string {
  if (!calendar) {
    return anchorLabel(view);
  }
  const currentStart = currentStartDate();
  if (view === "week") {
    const iso = getIsoWeek(parseDate(currentStart));
    const m = iso.match(/^(\d{4})-W(\d{2})$/);
    return m ? `${m[1]}年第${parseInt(m[2], 10)}周` : iso;
  }
  if (view === "month") {
    const d = parseDate(currentStart);
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  }
  return currentStart;
}

function isShowingAnchor(view: ViewKey): boolean {
  if (!anchorDate || !calendar) {
    return false;
  }
  const currentStart = currentStartDate();
  if (view === "week") {
    return getIsoWeek(parseDate(currentStart)) === getIsoWeek(parseDate(anchorDate));
  }
  if (view === "month") {
    const current = parseDate(currentStart);
    const anchor = parseDate(anchorDate);
    return current.getFullYear() === anchor.getFullYear() && current.getMonth() === anchor.getMonth();
  }
  return currentStart === anchorDate;
}

function panelToday(): string {
  return fmtDate(new Date());
}

function isShowingPanelCurrentAnchor(anchor: string): boolean {
  if (!panelMode || !calendar || !anchor) {
    return false;
  }
  const view = currentViewKey();
  const currentStart = fmtDate(calendar.view.currentStart);
  if (view === "week") {
    return getIsoWeek(parseDate(currentStart)) === getIsoWeek(parseDate(anchor));
  }
  if (view === "month") {
    const current = parseDate(currentStart);
    const target = parseDate(anchor);
    return current.getFullYear() === target.getFullYear() && current.getMonth() === target.getMonth();
  }
  return currentStart === anchor;
}

function syncPanelCurrentAnchor(): void {
  if (!panelMode || !calendar) {
    return;
  }
  const next = panelToday();
  if (next === panelCurrentAnchor) {
    return;
  }
  const shouldFollow = isShowingPanelCurrentAnchor(panelCurrentAnchor);
  panelCurrentAnchor = next;
  anchorDate = next;
  if (shouldFollow) {
    calendar.gotoDate(next);
  }
  syncToolbar(document.getElementById("app")!);
}

function gotoPanelCurrentAnchor(): void {
  if (!panelMode || !calendar) {
    return;
  }
  syncPanelCurrentAnchor();
  calendar.gotoDate(panelCurrentAnchor);
  syncToolbar(document.getElementById("app")!);
}

function parseWeekLabel(input: string): string | null {
  const trimmed = input.trim();
  let match = trimmed.match(/^(\d{4})-[wW](\d{1,2})$/);
  if (!match) {
    match = trimmed.match(/^(\d{4})年第(\d{1,2})周$/);
  }
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
  calendar?.setOption("defaultTimedEventDuration", durationToFullCalendar(defaultDurationMinutes));
  if (blockId) {
    await setBlockAttrs(blockId, {
      [DATE_ATTR]: anchorDate,
      [VIEW_ATTR]: currentViewKey(),
      [DURATION_ATTR]: String(defaultDurationMinutes)
    });
  }
  viewGotoDate(anchorDate);
  syncToolbar(document.getElementById("app")!);
}

function closeAnchorEditor(): void {
  if (!anchorEditor) {
    return;
  }
  const { el, dispose } = anchorEditor;
  anchorEditor = null;
  colorManagerRerender = null;
  dispose();
  el.remove();
}

/** 齿轮设置里的颜色管理：拖动排序、点击改色、删除、新增；改动即时落盘并同步各处 */
function setupColorManager(listEl: HTMLElement, addBtn: HTMLButtonElement): void {
  let dragFrom = -1;

  const commit = (next: string[]): void => {
    savePalette(next).catch(showError);
    // savePalette 已同步更新内存顺序，这里立即按新顺序刷新各处
    applyPaletteChanged();
  };

  const render = (): void => {
    const colors = getPalette();
    listEl.innerHTML = colors.map((c, i) => `
      <div class="cb-color-row" draggable="true" data-index="${i}">
        <span class="cb-color-grip" aria-hidden="true"><svg viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="3" r="1.3"/><circle cx="7.5" cy="3" r="1.3"/><circle cx="2.5" cy="8" r="1.3"/><circle cx="7.5" cy="8" r="1.3"/><circle cx="2.5" cy="13" r="1.3"/><circle cx="7.5" cy="13" r="1.3"/></svg></span>
        <input type="color" class="cb-color-input" value="${c}" aria-label="第 ${i + 1} 个颜色">
        <button type="button" class="cb-color-del" aria-label="删除颜色" title="删除颜色"${colors.length <= 1 ? " disabled" : ""}>×</button>
      </div>
    `).join("");

    listEl.querySelectorAll<HTMLElement>(".cb-color-row").forEach((row) => {
      const index = Number(row.dataset.index);
      const colorInput = row.querySelector(".cb-color-input") as HTMLInputElement;
      const delBtn = row.querySelector(".cb-color-del") as HTMLButtonElement;

      colorInput.addEventListener("change", () => {
        const val = colorInput.value.toLowerCase();
        if (!isValidColor(val)) {
          return;
        }
        const colors = getPalette();
        if (colors.some((c, i) => i !== index && c === val)) {
          showError(new Error("该颜色已存在"));
          colorInput.value = colors[index];
          return;
        }
        const next = colors.slice();
        next[index] = val;
        commit(next);
      });

      delBtn.addEventListener("click", () => {
        const colors = getPalette();
        if (colors.length <= 1) {
          return;
        }
        const next = colors.slice();
        next.splice(index, 1);
        commit(next);
      });

      row.addEventListener("dragstart", (event) => {
        dragFrom = index;
        row.classList.add("cb-color-row--dragging");
        event.dataTransfer?.setData("text/plain", String(index));
        if (event.dataTransfer) {
          event.dataTransfer.effectAllowed = "move";
        }
      });
      row.addEventListener("dragend", () => {
        dragFrom = -1;
        listEl.querySelectorAll(".cb-color-row--over, .cb-color-row--dragging")
          .forEach((r) => r.classList.remove("cb-color-row--over", "cb-color-row--dragging"));
      });
      row.addEventListener("dragover", (event) => {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "move";
        }
        if (dragFrom !== index) {
          row.classList.add("cb-color-row--over");
        }
      });
      row.addEventListener("dragleave", () => {
        row.classList.remove("cb-color-row--over");
      });
      row.addEventListener("drop", (event) => {
        event.preventDefault();
        row.classList.remove("cb-color-row--over");
        const to = index;
        if (dragFrom < 0 || dragFrom === to) {
          return;
        }
        const next = getPalette().slice();
        const [moved] = next.splice(dragFrom, 1);
        next.splice(to, 0, moved);
        dragFrom = -1;
        commit(next);
      });
    });
  };

  addBtn.addEventListener("click", () => {
    const colors = getPalette();
    const candidate = DEFAULT_PALETTE.find((c) => !colors.includes(c)) || "#888888";
    commit([...colors, candidate]);
  });

  colorManagerRerender = render;
  render();
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
  collapseSearchFromDocument();
  const el = document.createElement("div");
  el.className = "cb-filter-picker";
  el.setAttribute("role", "dialog");
  el.innerHTML = `<button type="button" class="cb-filter-all" aria-label="显示全部颜色" title="显示全部颜色">全部</button>` + getPalette().map((color) => {
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

function openSearchInline(root: HTMLElement): void {
  closePopover(true);
  closeAnchorEditor();
  closeWeatherPicker();
  closeColorFilterPicker();
  searchOpen = true;
  syncSearchButton(root);
  const input = root.querySelector(".cb-search-input") as HTMLInputElement | null;
  window.setTimeout(() => input?.focus(), 0);
}

function collapseSearchInline(root: HTMLElement): void {
  if (searchKeyword.trim()) {
    return;
  }
  searchOpen = false;
  searchComposing = false;
  syncSearchButton(root);
}

function collapseSearchFromDocument(): void {
  const root = document.getElementById("app");
  if (root) {
    collapseSearchInline(root);
  }
}

function applySearchKeyword(root: HTMLElement, value: string): void {
  searchKeyword = value;
  syncSearchButton(root);
  refresh();
}

function clearSearchKeyword(root: HTMLElement): void {
  applySearchKeyword(root, "");
  const input = root.querySelector(".cb-search-input") as HTMLInputElement | null;
  input?.focus();
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
  collapseSearchFromDocument();
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
  if (panelMode) {
    openPanelSettings(anchor);
    return;
  }
  if (anchorEditor) {
    closeAnchorEditor();
    return;
  }
  closePopover(true);
  closeAnchorEditor();
  closeWeatherPicker();
  closeColorFilterPicker();
  collapseSearchFromDocument();
  const view = currentViewKey();
  const current = anchorLabel(view);

  const el = document.createElement("div");
  el.className = "cb-anchor-editor";
  el.setAttribute("role", "dialog");
  
  let inputHtml = "";
  if (view === "week") {
    inputHtml = `<input class="cb-anchor-input" type="text" placeholder="例如：2026年第24周">`;
  } else {
    inputHtml = `<input class="cb-anchor-input" type="date">`;
  }

  el.innerHTML = `
    <label class="cb-anchor-label">${view === "week" ? "绑定周次" : "绑定日期"}</label>
    ${inputHtml}
    <label class="cb-anchor-label">默认事件时长</label>
    <select class="cb-duration-select">
      ${DURATION_OPTIONS.map((m) => `<option value="${m}">${durationLabel(m)}</option>`).join("")}
    </select>
    <div class="cb-anchor-divider"></div>
    <label class="cb-anchor-label">颜色管理</label>
    <div class="cb-color-list"></div>
    <button type="button" class="cb-color-add" aria-label="添加颜色">＋ 添加颜色</button>
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
  const colorList = el.querySelector(".cb-color-list") as HTMLElement;
  const colorAddBtn = el.querySelector(".cb-color-add") as HTMLButtonElement;
  setupColorManager(colorList, colorAddBtn);
  
  input.value = current;

  const focusInput = () => {
    input.focus();
    if (view === "week") {
      const val = input.value.trim();
      const m1 = val.match(/^(\d{4})年第(\d{1,2})周$/);
      const m2 = val.match(/^(\d{4})-[wW](\d{2})$/);
      if (m1) {
        const weekStr = m1[2];
        const start = val.indexOf(weekStr);
        const end = start + weekStr.length;
        input.setSelectionRange(start, end);
      } else if (m2) {
        const weekStr = m2[2];
        const start = val.indexOf(weekStr);
        const end = start + weekStr.length;
        input.setSelectionRange(start, end);
      } else {
        input.select();
      }
    } else {
      input.select();
    }
  };

  defaultDurationMinutes = normalizeDurationOption(defaultDurationMinutes);
  durationSelect.value = String(defaultDurationMinutes);

  const save = async () => {
    const value = input.value.trim();
    const nextDate = view === "week" ? parseWeekLabel(value) : (isValidDateStr(value) ? value : null);
    if (!nextDate) {
      showError(new Error(view === "week" ? "周格式应为 2026年第24周 或 2026-W24" : "日期格式应为 YYYY-MM-DD，例如 2026-06-12"));
      focusInput();
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
  focusInput();
}

function openPanelSettings(anchor: HTMLElement): void {
  if (anchorEditor) {
    closeAnchorEditor();
    return;
  }
  closePopover(true);
  closeAnchorEditor();
  closeWeatherPicker();
  closeColorFilterPicker();
  collapseSearchFromDocument();
  const view = currentViewKey();
  const el = document.createElement("div");
  el.className = "cb-anchor-editor cb-panel-settings";
  el.setAttribute("role", "dialog");
  el.innerHTML = `
    <label class="cb-anchor-label">视图</label>
    <div class="cb-panel-view-list" role="radiogroup" aria-label="切换日程面板视图">
      ${PANEL_VIEWS.map((v) => `<button type="button" class="cb-panel-view-item${v === view ? " cb-panel-view-item--active" : ""}" data-panel-view="${v}" role="radio" aria-checked="${v === view ? "true" : "false"}">${PANEL_VIEW_LABELS[v]}</button>`).join("")}
    </div>
    <label class="cb-anchor-label">默认事件时长</label>
    <select class="cb-duration-select">
      ${DURATION_OPTIONS.map((m) => `<option value="${m}">${durationLabel(m)}</option>`).join("")}
    </select>
    <div class="cb-anchor-divider"></div>
    <label class="cb-anchor-label">颜色管理</label>
    <div class="cb-color-list"></div>
    <button type="button" class="cb-color-add" aria-label="添加颜色">＋ 添加颜色</button>
    <div class="cb-anchor-actions">
      <button type="button" class="cb-anchor-cancel">取消</button>
      <button type="button" class="cb-anchor-save">保存</button>
    </div>
  `;
  document.body.appendChild(el);

  const durationSelect = el.querySelector(".cb-duration-select") as HTMLSelectElement;
  const saveBtn = el.querySelector(".cb-anchor-save") as HTMLButtonElement;
  const cancelBtn = el.querySelector(".cb-anchor-cancel") as HTMLButtonElement;
  const colorList = el.querySelector(".cb-color-list") as HTMLElement;
  const colorAddBtn = el.querySelector(".cb-color-add") as HTMLButtonElement;
  setupColorManager(colorList, colorAddBtn);
  defaultDurationMinutes = normalizeDurationOption(defaultDurationMinutes);
  durationSelect.value = String(defaultDurationMinutes);

  el.querySelectorAll<HTMLButtonElement>("[data-panel-view]").forEach((btn) => {
    btn.addEventListener("click", () => {
      switchPanelView(btn.dataset.panelView as ViewKey);
      el.querySelectorAll<HTMLButtonElement>("[data-panel-view]").forEach((item) => {
        const active = item === btn;
        item.classList.toggle("cb-panel-view-item--active", active);
        item.setAttribute("aria-checked", active ? "true" : "false");
      });
    });
  });

  const save = () => {
    savePanelDefaultDuration(parseDurationMinutes(durationSelect.value));
    closeAnchorEditor();
  };
  saveBtn.addEventListener("click", save);
  cancelBtn.addEventListener("click", closeAnchorEditor);

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeAnchorEditor();
    }
    const targetTag = (event.target as HTMLElement | null)?.tagName.toLowerCase();
    if (event.key === "Enter" && targetTag !== "button") {
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
}

/* ---------- 工具栏 ---------- */

function defaultCreateValues(): PopoverValues {
  const base = roundedCurrentDate();
  return {
    title: "",
    allDay: false,
    startDate: fmtDate(base),
    startTime: fmtTime(base),
    endDate: fmtDate(base),
    endTime: fmtTime(addMinutes(base, defaultDurationMinutes)),
    color: lastColor(),
    note: "",
    isTodo: false,
    repeat: noRepeat(fmtDate(base))
  };
}

/** 新建弹窗里的实时预览草稿块 */
interface DraftHandle {
  setTitle(title: string): void;
  setColor(color: string): void;
  setValues(values: PopoverValues): void;
  remove(): void;
}

function createDraft(values: PopoverValues): DraftHandle | null {
  const range = valuesToRange(values);
  const draftId = `draft-${Date.now().toString(36)}`;
  if (!calendar) {
    return null;
  }
  const event = calendar.addEvent({
    id: draftId,
    title: values.title || "（无标题）",
    start: range.start,
    end: range.end,
    allDay: range.allDay,
    backgroundColor: values.color,
    borderColor: "transparent",
    textColor: textColorFor(values.color),
    editable: false,
    classNames: ["cb-event-draft"]
  });
  return {
    setTitle: (title) => event?.setProp("title", title),
    setColor: (color) => {
      if (event) {
        applyEventColor(event, color);
      }
    },
    setValues: (v) => {
      if (event) {
        applyValuesToEvent(event, v);
      }
    },
    remove: () => event?.remove()
  };
}

function openCreatePopover(opts: {
  anchor: { x: number; y: number; rect?: DOMRect };
  ignoreOutside?: HTMLElement[];
  docId: string;
  /** 指定初始时间等取值；留空则用"当前时间＋默认时长" */
  values?: PopoverValues;
  /** 在日历上显示实时预览草稿块（标题/颜色/时间随弹窗即时变化）；快捷添加等无日历场景应留空 */
  liveDraft?: boolean;
  onDone?(result: { values: PopoverValues; range: { start: string; end: string; allDay: boolean }; id: string }): void;
  onCancelSaved?(id: string): void;
  onCancel?(): void;
}): void {
  const values = opts.values || defaultCreateValues();
  let savedId = "";
  let interacted = false;
  let latestValues = values;
  let saveTimer = 0;
  // 实时预览草稿块：弹窗里改标题/颜色/时间时，日历上即时跟随，保存后再换成正式事件
  let draft: DraftHandle | null = opts.liveDraft ? createDraft(values) : null;
  const removeDraft = () => {
    draft?.remove();
    draft = null;
  };
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
        docId: "",
        isTodo: v.isTodo,
        done: false,
        repeat: ruleFromValues(v)
      });
    } else {
      await store.update(savedId, {
        title: v.title,
        start: range.start,
        end: range.end,
        allDay: range.allDay,
        color: v.color,
        note: v.note,
        isTodo: v.isTodo,
        done: v.isTodo ? Boolean(store.get(savedId)?.done) : false,
        repeat: ruleFromValues(v)
      });
    }
    if (close) {
      opts.onDone?.({ values: v, range, id: savedId });
      syncAfterChange(store.get(savedId), savedId);
    }
  };

  openPopover({
    mode: "create",
    anchor: opts.anchor,
    ignoreOutside: opts.ignoreOutside,
    values,
    onTitleChange: (title) => {
      draft?.setTitle(title);
    },
    onColorChange: (color) => {
      draft?.setColor(color);
    },
    onValuesChange: (v) => {
      interacted = true;
      latestValues = v;
      draft?.setValues(v);
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        persistNew(latestValues).catch(showError);
      }, 500);
    },
    onSave: async (v) => {
      toolbarCreatePopoverOpen = false;
      window.clearTimeout(saveTimer);
      // 先让正式事件块就位（onDone→syncCalendarEvent），再撤掉草稿，避免该块出现空档闪烁
      await persistNew(v, true).catch(showError);
      removeDraft();
    },
    onClose: () => {
      toolbarCreatePopoverOpen = false;
      window.clearTimeout(saveTimer);
      if (interacted) {
        persistNew(latestValues, true).catch(showError).finally(removeDraft);
      } else {
        removeDraft();
        opts.onCancel?.();
      }
    },
    onCancel: () => {
      toolbarCreatePopoverOpen = false;
      window.clearTimeout(saveTimer);
      removeDraft();
      const removedId = savedId;
      const afterCancel = () => {
        opts.onCancelSaved?.(removedId);
        opts.onCancel?.();
      };
      if (savedId) {
        store.remove(savedId).then(afterCancel).catch(showError);
      } else {
        opts.onCancel?.();
      }
    }
  });
}

function switchPanelView(view: ViewKey, date?: Date | string): void {
  if (!panelMode || !calendar || !VIEW_MAP[view]) {
    return;
  }
  closeAnchorEditor();
  closeColorFilterPicker();
  collapseSearchFromDocument();
  closeWeatherPicker();
  closePopover(true);
  toolbarCreatePopoverOpen = false;
  hideEventNoteTooltip();
  const target = date || calendar.getDate();
  calendar.changeView(VIEW_MAP[view], target);
  syncToolbar(document.getElementById("app")!);
  scheduleSyncCalendarScrollbars();
}

function buildToolbar(root: HTMLElement, view: ViewKey): void {
  const anchor = anchorLabel(view);
  const settingsLabel = panelMode ? "切换视图" : `修改绑定${view === "week" ? "周次" : "日期"}`;
  root.innerHTML = `
    <div class="cb-toolbar">
      <div class="cb-toolbar-left">
        <button type="button" class="cb-icon-btn cb-btn-settings" aria-label="${settingsLabel}" title="${settingsLabel}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5l-2-3.5l-2.4 1a8.4 8.4 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A8.4 8.4 0 0 0 7 6.5l-2.4-1l-2 3.5l2 1.5c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2 1.5l2 3.5l2.4-1a8.4 8.4 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a8.4 8.4 0 0 0 2.6-1.5l2.4 1l2-3.5l-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/></svg>
        </button>
        <button type="button" class="cb-icon-btn cb-btn-filter" aria-label="按颜色筛选日程" title="按颜色筛选日程">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 5h18l-7 8v5.2l-4 2V13L3 5Z"/></svg>
        </button>
        <button type="button" class="cb-icon-btn cb-btn-screenshot" aria-label="截取当前日程视图" title="截取当前日程视图">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 4h3l2-2h6l2 2h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm8 3a5 5 0 1 0 0 10a5 5 0 0 0 0-10Zm0 2a3 3 0 1 1 0 6a3 3 0 0 1 0-6Z"/></svg>
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
        <div class="cb-toolbar-search">
          <div class="cb-search-field">
            <input class="cb-search-input" type="text" placeholder="标题 / 备注" autocomplete="off">
            <button type="button" class="cb-search-clear" aria-label="清空搜索" title="清空搜索" hidden>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M7 7l10 10M17 7 7 17"/></svg>
            </button>
          </div>
          <button type="button" class="cb-icon-btn cb-btn-search" aria-label="搜索当前日程视图" title="搜索当前日程视图">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m20 20-4.4-4.4"/><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>
          </button>
        </div>
        <button type="button" class="cb-icon-btn cb-btn-new" aria-label="新建日程" title="新建日程">＋</button>
      </div>
    </div>
    <div class="cb-error" style="display:none"></div>
    <div class="cb-calendar"></div>
  `;

  root.querySelector(".cb-btn-screenshot")!.addEventListener("click", (event) => {
    captureCurrentView(event.currentTarget as HTMLButtonElement).catch(showError);
  });
  root.querySelector(".cb-btn-settings")!.addEventListener("click", (event) => {
    editAnchorDate(event.currentTarget as HTMLElement);
  });
  root.querySelector(".cb-btn-filter")!.addEventListener("click", (event) => {
    openColorFilterPicker(event.currentTarget as HTMLElement);
  });
  root.querySelector(".cb-btn-search")!.addEventListener("click", (event) => {
    openSearchInline(root);
  });
  const searchInput = root.querySelector(".cb-search-input") as HTMLInputElement;
  const searchClear = root.querySelector(".cb-search-clear") as HTMLButtonElement;
  searchInput.value = searchKeyword;
  searchInput.addEventListener("compositionstart", () => {
    searchComposing = true;
  });
  searchInput.addEventListener("compositionend", () => {
    searchComposing = false;
    applySearchKeyword(root, searchInput.value);
  });
  searchInput.addEventListener("input", (event) => {
    if (searchComposing || (event as InputEvent).isComposing) {
      return;
    }
    applySearchKeyword(root, searchInput.value);
  });
  searchInput.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    if (searchInput.value) {
      clearSearchKeyword(root);
      return;
    }
    searchOpen = false;
    searchInput.blur();
    syncSearchButton(root);
  });
  searchInput.addEventListener("blur", () => collapseSearchInline(root));
  searchClear.addEventListener("click", () => clearSearchKeyword(root));
  root.querySelector(".cb-btn-anchor")!.addEventListener("click", () => {
    if (panelMode) {
      gotoPanelCurrentAnchor();
    } else if (anchorDate) {
      viewGotoDate(anchorDate);
      syncToolbar(root);
    }
  });
  root.querySelector(".cb-nav-prev")!.addEventListener("click", () => viewStep(-1));
  root.querySelector(".cb-nav-next")!.addEventListener("click", () => viewStep(1));
  root.querySelector(".cb-btn-new")!.addEventListener("click", (event) => {
    if (toolbarCreatePopoverOpen) {
      closePopover();
      return;
    }
    collapseSearchFromDocument();
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    openCreatePopover({
      anchor: { x: rect.left, y: rect.bottom + 6, rect },
      ignoreOutside: [target],
      docId: docId,
      liveDraft: true,
      onDone: ({ range, id }) => {
        viewGotoDate(range.start.slice(0, 10));
        syncCalendarEvent(id);
      },
      onCancelSaved: (id) => {
        syncCalendarEvent(id);
      }
    });
    toolbarCreatePopoverOpen = true;
  });
  syncColorFilterButton(root);
  syncSearchButton(root);
}

function syncToolbar(root: HTMLElement): void {
  const key = currentViewKey();
  const anchorBtn = root.querySelector(".cb-btn-anchor") as HTMLElement;
  if (anchorBtn) {
    anchorBtn.textContent = visibleLabel(key) || (key === "week" ? "锚定周" : "锚定日期");
    anchorBtn.classList.toggle("cb-btn-anchor--active", panelMode ? isShowingPanelCurrentAnchor(panelCurrentAnchor) : isShowingAnchor(key));
  }
}

/* ---------- 状态持久化 ---------- */

let persistTimer = 0;
function persistViewState(): void {
  if (!blockId || currentViewKey() === "month") {
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
  const el = target instanceof HTMLElement ? target : null;
  if (!el) {
    return false;
  }
  const tag = el.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || el.isContentEditable;
}

/** 输入框里应由浏览器自己处理的编辑组合键；转发给思源会误触发文档撤销、全选等 */
function isNativeEditingCombo(event: KeyboardEvent): boolean {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) {
    return false;
  }
  return ["a", "c", "v", "x", "z", "y"].includes(event.key.toLowerCase());
}

/**
 * 挂件跑在 iframe 里，键盘事件不会越过 iframe 边界冒泡到思源宿主，
 * 于是焦点停在日程块或日程面板内时，⌘, 打开设置这类思源全局快捷键会失效。
 * 这里把带修饰键的组合原样补发到宿主里的 iframe 元素上，由它照常冒泡到思源的全局监听；
 * 宿主已消费（preventDefault）时，同步阻止挂件内的默认行为，避免一次按键被两边各做一遍。
 */
function forwardHotkeyToHost(event: KeyboardEvent): void {
  let host: Window | null = null;
  let target: EventTarget | null = null;
  try {
    host = window.parent;
    if (!host || host === window || !host.document) {
      return;
    }
    target = (window.frameElement as HTMLElement | null) || host.document;
  } catch {
    // 宿主跨域时无法转发（思源里不会出现），静默放弃
    return;
  }
  if (!target) {
    return;
  }
  const Ctor = (host as Window & { KeyboardEvent?: typeof KeyboardEvent }).KeyboardEvent || KeyboardEvent;
  const clone = new Ctor("keydown", {
    key: event.key,
    code: event.code,
    location: event.location,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    isComposing: false,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: host,
    // 思源部分判定仍读 keyCode/which，补上旧字段（Chromium 支持在 init 里传）
    keyCode: event.keyCode,
    which: event.keyCode
  } as KeyboardEventInit);
  try {
    (target as HTMLElement | Document).dispatchEvent(clone);
  } catch {
    return;
  }
  if (clone.defaultPrevented) {
    event.preventDefault();
  }
}

function installHostHotkeyBridge(): void {
  window.addEventListener("keydown", (event) => {
    // 挂件自己已经处理掉的按键（撤销、切换日期等）不再外送
    if (event.defaultPrevented || event.isComposing) {
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey) {
      return;
    }
    if (isEditableTarget(event.target) && isNativeEditingCombo(event)) {
      return;
    }
    forwardHotkeyToHost(event);
  });
}

function focusWidgetFrame(target: EventTarget | null): void {
  try {
    // 聚焦子 window 不一定会同步激活思源宿主里的 iframe；若宿主仍持有焦点，
    // FullCalendar 第一次拖拽的 down→move→up 序列可能在激活 iframe 时被打断。
    const hostFrame = window.frameElement as HTMLElement | null;
    if (hostFrame && typeof hostFrame.focus === "function") {
      try {
        hostFrame.focus({ preventScroll: true });
      } catch {
        hostFrame.focus();
      }
    }
    window.focus();
  } catch {
    // SiYuan/Chromium 某些宿主状态可能拒绝 focus；失败不应阻塞交互。
  }
  if (isEditableTarget(target)) {
    return;
  }
  const active = document.activeElement;
  if (active && active !== document.body && active !== document.documentElement) {
    return;
  }
  const root = document.documentElement;
  const previousTabIndex = root.getAttribute("tabindex");
  root.setAttribute("tabindex", "-1");
  try {
    root.focus({ preventScroll: true });
  } catch {
    // 老内核不支持 focus options 时忽略。
  }
  if (previousTabIndex === null) {
    root.removeAttribute("tabindex");
  } else {
    root.setAttribute("tabindex", previousTabIndex);
  }
}

function primeCalendarInteraction(target: EventTarget | null = null): void {
  focusWidgetFrame(target);
  if (!calendar || interactionPrimeRaf) {
    return;
  }
  interactionPrimeRaf = window.requestAnimationFrame(() => {
    interactionPrimeRaf = 0;
    calendar.updateSize();
    scheduleSyncCalendarScrollbars();
    adjustAllEventDurations();
  });
}

function cancelCalendarInteractionPrime(): void {
  if (!interactionPrimeRaf) {
    return;
  }
  window.cancelAnimationFrame(interactionPrimeRaf);
  interactionPrimeRaf = 0;
}

/* ---------- 启动 ---------- */

async function boot(): Promise<void> {
  initThemeBridge(refreshRenderedEventColors);

  const params = new URLSearchParams(window.location.search);
  panelMode = params.get("mode") === "panel";
  if (params.get("view") === "quickadd") {
    await bootQuickAdd();
    return;
  }
  installQuickAddShortcutBridge();
  if (panelMode) {
    document.body.dataset.mode = "panel";
    defaultDurationMinutes = loadPanelDefaultDuration();
  }

  const frame = window.frameElement as HTMLElement | null;
  const blockEl = (frame?.closest("[data-node-id]") as HTMLElement | null) || null;
  blockId = panelMode ? "" : blockEl?.getAttribute("data-node-id") || "";

  // 获取所属文档的 root_id
  if (blockId) {
    docId = await getRootId(blockId);
  }
  store.docId = docId;

  let view = (params.get("view") as ViewKey) || (panelMode ? "month" : "week");
  let date = panelMode ? panelToday() : (params.get("date") || "");
  if (blockId) {
    try {
      const attrs = await getBlockAttrs(blockId);
      if (attrs[VIEW_ATTR] && VIEW_MAP[attrs[VIEW_ATTR] as ViewKey] && attrs[VIEW_ATTR] !== "month") {
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
  if (!panelMode && view === "month") {
    view = "week";
  }
  persistedViewKey = view;
  panelCurrentAnchor = panelToday();
  if (panelMode) {
    date = panelCurrentAnchor;
  }

  // 新插入的挂件块给一个合适的默认高度（思源把高度存于块的 style 属性）
  if (!panelMode && blockEl && !blockEl.style.height) {
    blockEl.style.height = DEFAULT_HEIGHT;
    if (blockId) {
      setBlockAttrs(blockId, { style: `height: ${DEFAULT_HEIGHT};` }).catch(() => {});
    }
  }

  // 锚定日期：面板使用当前时间；嵌入块优先用标题解析，否则用属性或今日。
  anchorDate = date || fmtDate(new Date());

  const root = document.getElementById("app")!;
  buildToolbar(root, view);

  try {
    await loadPalette();
  } catch (err) {
    console.warn("schedule-block: 取色板加载失败，使用默认取色板", err);
  }
  syncCreateColor();
  selectAllColors();
  syncColorFilterButton(root);

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

  const calendarHost = root.querySelector(".cb-calendar") as HTMLElement;
  calendar = new Calendar(calendarHost, {
    plugins: [timeGridPlugin, dayGridPlugin, interactionPlugin],
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
    moreLinkClick: (info) => {
      lastClickedMoreLink = (info.jsEvent.target as HTMLElement).closest<HTMLElement>(".fc-daygrid-more-link");
      scheduleAdjustMorePopover();
      return "popover";
    },
    fixedWeekCount: false,
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
    eventBackgroundColor: lastColor(),
    eventBorderColor: "transparent",
    eventTextColor: textColorFor(lastColor()),
    slotLabelFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    eventTimeFormat: { hour: "2-digit", minute: "2-digit", hour12: false },
    moreLinkText: (n) => `还有 ${n} 项`,
    dayCellContent: (arg) => {
      if (VIEW_KEY[arg.view.type] !== "month") {
        return { html: arg.dayNumberText };
      }
      const dateText = arg.date.getDate() === 1 ? `${arg.date.getMonth() + 1}月${arg.date.getDate()}日` : `${arg.date.getDate()}日`;
      const lunar = monthLunarLabel(arg.date);
      const monthWeatherKind = weatherStore.get(fmtDate(arg.date)) || "";
      const monthWeather = monthWeatherKind
        ? `<span class="cb-month-weather" aria-label="${WEATHER_LABELS[monthWeatherKind]}" title="${WEATHER_LABELS[monthWeatherKind]}">${weatherIcon(monthWeatherKind)}</span>`
        : "";
      return {
        html: `<span class="cb-month-day-head"><span class="cb-month-day-solar">${dateText}</span><span class="cb-month-day-lunar">${lunar}</span>${monthWeather}</span>`
      };
    },
    dayHeaderContent: (arg) => {
      const dow = arg.date.toLocaleDateString("zh-CN", { weekday: "short" });
      if (VIEW_KEY[arg.view.type] === "month") {
        return { html: `<span class="cb-dh-month-weekday">${dow}</span>` };
      }
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
    events: (info, success) => success(occurrencesForRange(fmtDate(info.start), fmtDate(info.end)).map(toFC)),
    eventClassNames,
    eventContent: renderEventContent,
    eventDidMount: onEventDidMount,
    eventWillUnmount: onEventWillUnmount,
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
      scheduleSyncCalendarScrollbars();
    }
  });
  calendar.render();
  refreshRenderedEventColors();

  const popoverObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && (node.classList.contains("fc-popover") || node.querySelector(".fc-popover"))) {
          adjustMorePopover();
        }
      }
    }
  });
  popoverObserver.observe(document.body, { childList: true, subtree: true });

  syncToolbar(root);
  scheduleSyncCalendarScrollbars();

  const onKeydown = (event: KeyboardEvent) => {
    if (isEditableTarget(event.target)) {
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === "z") {
      event.preventDefault();
      store.undo()
        .then((ok) => {
          if (ok) {
            refresh();
          }
        })
        .catch(showError);
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "t") {
      event.preventDefault();
      if (panelMode) {
        gotoPanelCurrentAnchor();
      } else if (anchorDate) {
        viewGotoDate(anchorDate);
        syncToolbar(root);
      }
      return;
    }
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      viewStep(event.key === "ArrowLeft" ? -1 : 1);
    }
  };
  window.addEventListener("keydown", onKeydown);
  // 注册在挂件自身快捷键之后：本挂件已消费的按键不会再外送给思源
  installHostHotkeyBridge();

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
  onPaletteRemoteChange(applyPaletteChanged);

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        if (isDirty) {
          isDirty = false;
          refresh();
        } else {
          calendar.updateSize();
          scheduleSyncCalendarScrollbars();
          adjustAllEventDurations();
          scheduleAdjustMorePopover();
        }
      }
    }
  });
  const calendarEl = root.querySelector(".cb-calendar") as HTMLElement;
  if (calendarEl) {
    resizeObserver.observe(calendarEl);
    const prepareBeforeInteraction = (ev: Event) => primeCalendarInteraction(ev.target);
    const beginInteraction = (ev: Event) => {
      // pointerenter/mouseenter 安排的下一帧尺寸校准不能插进已经开始的拖拽。
      cancelCalendarInteractionPrime();
      focusWidgetFrame(ev.target);
    };
    calendarEl.addEventListener("pointerdown", beginInteraction, true);
    calendarEl.addEventListener("mousedown", beginInteraction, true);
    calendarEl.addEventListener("touchstart", beginInteraction, { capture: true, passive: true });
    calendarEl.addEventListener("pointerenter", prepareBeforeInteraction, { passive: true });
    calendarEl.addEventListener("mouseenter", prepareBeforeInteraction, { passive: true });
    calendarEl.addEventListener("click", (ev) => {
      const dayNumber = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".fc-daygrid-day-number");
      if (panelMode && currentViewKey() === "month" && dayNumber) {
        const dayCell = dayNumber.closest<HTMLElement>(".fc-daygrid-day[data-date]");
        const date = dayCell?.dataset.date || "";
        if (isValidDateStr(date)) {
          ev.preventDefault();
          ev.stopPropagation();
          switchPanelView("day", parseDate(date));
          return;
        }
      }
      const todoCheck = (ev.target as HTMLElement | null)?.closest<HTMLElement>(".cb-event-check[data-event-id]");
      if (todoCheck) {
        ev.preventDefault();
        ev.stopPropagation();
        const id = todoCheck.dataset.eventId || "";
        if (id) {
          toggleTodoDone(id).catch(showError);
        }
        return;
      }
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
      createAtPoint(date, currentViewKey() === "month" ? true : allDay);
    });
  }

  const panelCurrentTimer = window.setInterval(syncPanelCurrentAnchor, 60000);

  document.addEventListener("visibilitychange", () => {
    syncPanelCurrentAnchor();
    if (!document.hidden) {
      primeCalendarInteraction();
    }
    if (!document.hidden && isDirty) {
      isDirty = false;
      refresh();
    }
  });
  window.addEventListener("focus", () => {
    syncPanelCurrentAnchor();
    primeCalendarInteraction();
    if (isDirty) {
      isDirty = false;
      refresh();
    }
  });

  if (!storeReady) {
    showError(new Error("无法读取日程数据，请在思源中打开"));
  }
  store.startAutoRefresh(30000);
  window.addEventListener("beforeunload", () => {
    window.clearInterval(panelCurrentTimer);
    popoverObserver.disconnect();
    // 弹窗可能挂在思源宿主文档里，挂件卸载前先收走，免得留下孤儿节点
    closePopover(true);
  });
}

async function captureCurrentView(button: HTMLButtonElement): Promise<void> {
  closePopover(true);
  closeColorFilterPicker();
  collapseSearchFromDocument();
  closeWeatherPicker();
  hideEventNoteTooltip();

  const appEl = document.getElementById("app");
  if (!appEl) {
    throw new Error("找不到当前日程视图");
  }

  button.disabled = true;
  const previousTitle = button.title;
  button.title = "正在截图...";
  document.body.classList.add("cb-screenshot-capturing");
  calendar?.setOption("height", "auto");
  calendar?.updateSize();
  refreshWeatherHeaders();
  adjustAllEventDurations();
  scheduleSyncCalendarScrollbars();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  calendar?.updateSize();
  await new Promise((resolve) => requestAnimationFrame(resolve));

  try {
    const canvas = await html2canvas(appEl, {
      backgroundColor: getComputedStyle(document.body).backgroundColor || null,
      scale: Math.min(window.devicePixelRatio || 1, 2),
      useCORS: true
    });
    const blob = await canvasToPngBlob(canvas);
    await saveScreenshotBlob(blob, screenshotFileName());
  } finally {
    document.body.classList.remove("cb-screenshot-capturing");
    calendar?.setOption("height", "100%");
    calendar?.updateSize();
    button.disabled = false;
    button.title = previousTitle;
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("截图生成失败"));
      }
    }, "image/png");
  });
}

function screenshotFileName(): string {
  const startStr = fmtDate(calendar.view.activeStart);
  const endStr = addDaysStr(fmtDate(calendar.view.activeEnd), -1);
  const range = startStr === endStr ? startStr : `${startStr}_${endStr}`;
  const key = currentViewKey();
  const viewName = key === "week" ? "周历块" : key === "month" ? "日程月视图" : "日历块";
  return `${viewName}-${range}.png`;
}

async function saveScreenshotBlob(blob: Blob, fileName: string): Promise<void> {
  type FilePickerWindow = Window & {
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
      types?: Array<{
        description: string;
        accept: Record<string, string[]>;
      }>;
    }) => Promise<{
      createWritable: () => Promise<{
        write: (data: Blob) => Promise<void>;
        close: () => Promise<void>;
      }>;
    }>;
  };
  const picker = (window as FilePickerWindow).showSaveFilePicker;
  if (picker) {
    const pickerOptions = {
      suggestedName: fileName,
      startIn: "desktop" as const,
      types: [{
        description: "PNG 图片",
        accept: { "image/png": [".png"] }
      }]
    };
    let handle: Awaited<ReturnType<NonNullable<FilePickerWindow["showSaveFilePicker"]>>>;
    try {
      handle = await picker(pickerOptions);
    } catch (err) {
      if (isAbortError(err)) {
        return;
      }
      if (!(err instanceof TypeError)) {
        throw err;
      }
      const { startIn, ...fallbackOptions } = pickerOptions;
      try {
        handle = await picker(fallbackOptions);
      } catch (fallbackErr) {
        if (isAbortError(fallbackErr)) {
          return;
        }
        throw fallbackErr;
      }
    }
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return;
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

async function bootQuickAdd(): Promise<void> {
  initThemeBridge();
  installHostHotkeyBridge();
  try {
    await loadPalette();
  } catch (err) {
    console.warn("schedule-block: 取色板加载失败，使用默认取色板", err);
  }
  try {
    await store.load();
  } catch (err) {
    console.error("schedule-block: 日程数据加载失败", err);
    showError(err);
    return;
  }

  const notifyHost = (savedText: string | null) => {
    postUiMessage(savedText
      ? { type: "quickadd-saved", text: savedText }
      : { type: "quickadd-cancel" }
    );
  };

  const root = document.getElementById("app")!;
  document.documentElement.classList.add("cb-quickadd-mode");
  document.body.classList.add("cb-quickadd-mode");
  root.innerHTML = `<div class="cb-quickadd-backdrop" aria-hidden="true"></div>`;
  root.querySelector(".cb-quickadd-backdrop")?.addEventListener("mousedown", () => notifyHost(null));
  openCreatePopover({
    anchor: { x: window.innerWidth / 2 - 171, y: window.innerHeight / 2 - 180 },
    docId: "",
    onDone: ({ values }) => notifyHost(`已记日程: ${values.title || "（无标题）"}`),
    onCancel: () => notifyHost(null)
  });
}

boot();
