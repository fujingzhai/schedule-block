import { addDaysStr } from "./util";

/** 谷歌日历风格的取色板 */
export const PALETTE = [
  "#616161", // 石墨灰
  "#d50000", // 番茄红
  "#e67c73", // 火鹤红
  "#f4511e", // 橘子橙
  "#039be5", // 孔雀蓝
  "#3f51b5", // 蓝莓
  "#7986cb", // 薰衣草
  "#33b679", // 鼠尾草绿
  "#0b8043", // 罗勒绿
  "#f6bf26", // 香蕉黄
  "#8e24aa" // 葡萄紫
];
export const DEFAULT_COLOR = PALETTE[0];

export interface PopoverValues {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  /** 含当天（展示口径）；存储时全天日程再转排他 */
  endDate: string;
  endTime: string;
  color: string;
  note: string;
}

export interface PopoverAnchor {
  x: number;
  y: number;
  rect?: DOMRect;
}

export interface PopoverOptions {
  mode: "create" | "edit";
  anchor: PopoverAnchor;
  values: PopoverValues;
  onSave(values: PopoverValues): void;
  onDelete?(): void;
  /** 任何方式关闭（保存、删除、取消、点击外部）都会回调 */
  onClose?(): void;
}

let current: { el: HTMLElement; opts: PopoverOptions; dispose(): void } | null = null;

export function closePopover(silent = false): void {
  if (!current) {
    return;
  }
  const { el, opts, dispose } = current;
  current = null;
  dispose();
  el.remove();
  if (!silent) {
    opts.onClose?.();
  }
}

export function isPopoverOpen(): boolean {
  return current !== null;
}

export function openPopover(opts: PopoverOptions): void {
  closePopover();

  const el = document.createElement("div");
  el.className = "cb-popover";
  el.setAttribute("role", "dialog");
  el.innerHTML = `
    <input class="cb-pop-title" type="text" placeholder="添加标题" spellcheck="false">
    <div class="cb-pop-row cb-pop-when">
      <svg class="cb-pop-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 2a10 10 0 1 0 10 10A10 10 0 0 0 12 2Zm0 18a8 8 0 1 1 8-8a8 8 0 0 1-8 8Zm.5-13H11v6l5.2 3.1l.8-1.2l-4.5-2.7Z"/></svg>
      <div class="cb-pop-when-fields">
        <div class="cb-pop-dates">
          <input class="cb-start-date" type="date">
          <span class="cb-date-sep">至</span>
          <input class="cb-end-date" type="date">
        </div>
        <div class="cb-pop-times">
          <input class="cb-start-time" type="time">
          <span class="cb-time-sep">–</span>
          <input class="cb-end-time" type="time">
        </div>
        <label class="cb-allday"><input class="cb-allday-check" type="checkbox">全天</label>
      </div>
    </div>
    <div class="cb-pop-row cb-pop-colors">
      <svg class="cb-pop-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12 22a10 10 0 1 1 10-10c0 2.21-1.79 4-4 4h-1.77c-.28 0-.5.22-.5.5c0 .12.05.23.13.33c.41.47.64 1.06.64 1.67A3.5 3.5 0 0 1 13 22h-1Zm-5.5-9a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3Zm3-4a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3Zm5 0a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3Zm3 4a1.5 1.5 0 1 0 0-3a1.5 1.5 0 0 0 0 3Z"/></svg>
      <div class="cb-swatches"></div>
    </div>
    <div class="cb-pop-row cb-pop-note-row">
      <svg class="cb-pop-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M3 5h18v2H3V5Zm0 6h18v2H3v-2Zm0 6h12v2H3v-2Z"/></svg>
      <textarea class="cb-pop-note" rows="2" placeholder="添加备注" spellcheck="false"></textarea>
    </div>
    <div class="cb-pop-footer">
      <button type="button" class="cb-pop-delete">删除</button>
      <span class="cb-pop-spacer"></span>
      <button type="button" class="cb-pop-cancel">取消</button>
      <button type="button" class="cb-pop-save">保存</button>
    </div>
  `;
  document.body.appendChild(el);

  const $ = <T extends HTMLElement>(sel: string) => el.querySelector(sel) as T;
  const titleInput = $<HTMLInputElement>(".cb-pop-title");
  const startDate = $<HTMLInputElement>(".cb-start-date");
  const endDate = $<HTMLInputElement>(".cb-end-date");
  const dateSep = $<HTMLElement>(".cb-date-sep");
  const timesRow = $<HTMLElement>(".cb-pop-times");
  const startTime = $<HTMLInputElement>(".cb-start-time");
  const endTime = $<HTMLInputElement>(".cb-end-time");
  const allDayCheck = $<HTMLInputElement>(".cb-allday-check");
  const swatches = $<HTMLElement>(".cb-swatches");
  const noteInput = $<HTMLTextAreaElement>(".cb-pop-note");
  const deleteBtn = $<HTMLButtonElement>(".cb-pop-delete");

  const v = { ...opts.values };
  titleInput.value = v.title;
  startDate.value = v.startDate;
  endDate.value = v.endDate;
  startTime.value = v.startTime;
  endTime.value = v.endTime;
  allDayCheck.checked = v.allDay;
  noteInput.value = v.note;
  if (!opts.onDelete) {
    deleteBtn.style.display = "none";
  }

  let color = v.color || DEFAULT_COLOR;
  const renderSwatches = () => {
    swatches.innerHTML = "";
    for (const c of PALETTE) {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "cb-swatch" + (c === color ? " cb-swatch--active" : "");
      dot.style.background = c;
      dot.addEventListener("click", () => {
        color = c;
        renderSwatches();
      });
      swatches.appendChild(dot);
    }
  };
  renderSwatches();

  const syncRows = () => {
    const allDay = allDayCheck.checked;
    timesRow.style.display = allDay ? "none" : "";
    const showEndDate = allDay || endDate.value !== startDate.value;
    endDate.style.display = showEndDate ? "" : "none";
    dateSep.style.display = showEndDate ? "" : "none";
  };
  syncRows();

  allDayCheck.addEventListener("change", () => {
    if (allDayCheck.checked && endDate.value < startDate.value) {
      endDate.value = startDate.value;
    }
    if (!allDayCheck.checked) {
      endDate.value = startDate.value;
    }
    syncRows();
  });
  startDate.addEventListener("change", () => {
    if (endDate.style.display === "none" || endDate.value < startDate.value) {
      endDate.value = startDate.value;
    }
    syncRows();
  });

  const collect = (): PopoverValues => {
    const allDay = allDayCheck.checked;
    let ed = endDate.style.display === "none" ? startDate.value : endDate.value;
    if (!ed || ed < startDate.value) {
      ed = startDate.value;
    }
    let st = startTime.value || "09:00";
    let et = endTime.value || "";
    if (!allDay && ed === startDate.value && et && et <= st) {
      et = "";
    }
    if (!et) {
      const [h, m] = st.split(":").map(Number);
      const total = Math.min(h * 60 + m + 60, 23 * 60 + 59);
      et = `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    }
    return {
      title: titleInput.value.trim() || "（无标题）",
      allDay,
      startDate: startDate.value || v.startDate,
      startTime: st,
      endDate: ed,
      endTime: et,
      color,
      note: noteInput.value.trim()
    };
  };

  const save = () => {
    const values = collect();
    closePopover(true);
    opts.onSave(values);
  };
  $<HTMLButtonElement>(".cb-pop-save").addEventListener("click", save);
  $<HTMLButtonElement>(".cb-pop-cancel").addEventListener("click", () => closePopover());
  deleteBtn.addEventListener("click", () => {
    closePopover(true);
    opts.onDelete?.();
  });

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closePopover();
    }
    if (event.key === "Enter" && event.target === titleInput) {
      event.preventDefault();
      save();
    }
  };
  el.addEventListener("keydown", onKeydown);

  const onOutsideMousedown = (event: MouseEvent) => {
    if (!el.contains(event.target as Node)) {
      closePopover();
    }
  };
  // 延迟挂载，避免触发本次打开的那一下点击
  const timer = window.setTimeout(() => {
    document.addEventListener("mousedown", onOutsideMousedown, true);
  }, 0);

  const dispose = () => {
    window.clearTimeout(timer);
    document.removeEventListener("mousedown", onOutsideMousedown, true);
  };
  current = { el, opts, dispose };

  position(el, opts.anchor);
  titleInput.focus();
  titleInput.select();
}

function position(el: HTMLElement, anchor: PopoverAnchor): void {
  const margin = 8;
  const { width, height } = el.getBoundingClientRect();
  let x: number;
  let y: number;
  if (anchor.rect) {
    x = anchor.rect.right + 10;
    y = anchor.rect.top;
    if (x + width + margin > window.innerWidth) {
      x = anchor.rect.left - width - 10;
    }
    if (x < margin) {
      x = Math.min(Math.max(anchor.rect.left, margin), window.innerWidth - width - margin);
      y = anchor.rect.bottom + 8;
    }
  } else {
    x = anchor.x + 10;
    y = anchor.y + 10;
  }
  x = Math.min(Math.max(x, margin), Math.max(window.innerWidth - width - margin, margin));
  y = Math.min(Math.max(y, margin), Math.max(window.innerHeight - height - margin, margin));
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
}

/** 展示口径（含当天）→ 存储口径（全天排他 end） */
export function valuesToRange(v: PopoverValues): { start: string; end: string; allDay: boolean } {
  if (v.allDay) {
    const last = v.endDate >= v.startDate ? v.endDate : v.startDate;
    return { allDay: true, start: v.startDate, end: addDaysStr(last, 1) };
  }
  let start = `${v.startDate}T${v.startTime}`;
  let end = `${v.endDate}T${v.endTime}`;
  if (end <= start) {
    end = `${v.startDate}T${v.endTime}`;
    if (end <= start) {
      const [h, m] = v.startTime.split(":").map(Number);
      const total = Math.min(h * 60 + m + 30, 23 * 60 + 59);
      end = `${v.startDate}T${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
    }
  }
  return { allDay: false, start, end };
}
