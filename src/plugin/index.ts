import { Dialog, Menu, Plugin, Protyle, fetchPost, getActiveEditor, getAllEditor, openTab, showMessage } from "siyuan";
import { fmtDate, parseDateFromTitle } from "../shared/date";

type ViewKey = "day" | "week";
const PANEL_TAB = "schedulePanel";

const BLOCK_LABEL: Record<ViewKey, string> = {
  day: "日历块",
  week: "周历块"
};

const VIEW_PINYIN: Record<ViewKey, string[]> = {
  day: ["rilikuai", "ri", "day", "calendar"],
  week: ["zhoulikuai", "zhou", "week"]
};

const VIEWS: ViewKey[] = ["day", "week"];

interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  data: T;
}

interface BlockOperation {
  doOperations?: Array<{ id?: string }>;
}

interface BlockRow {
  id: string;
  root_id: string;
  type: string;
}

interface InsertContext {
  blockID: string;
  docID: string;
}

export default class CalendarBlockPlugin extends Plugin {
  private topBarElement?: HTMLElement;
  private lastContext: InsertContext = { blockID: "", docID: "" };
  private quickDialog: Dialog | null = null;
  private uiChannel: BroadcastChannel | null = null;

  onload() {
    this.addIcons(`
      <symbol id="iconCalendarBlock" viewBox="0 0 32 32">
        <path d="M8 4h2v4H8V4Zm14 0h2v4h-2V4Z"></path>
        <path d="M5 7h22a2 2 0 0 1 2 2v17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Zm0 7v12h22V14H5Zm0-5v3h22V9H5Z"></path>
      </symbol>
    `);

    this.topBarElement = this.addTopBar({
      icon: "iconCalendarBlock",
      title: "日程块",
      position: "right",
      callback: (event) => this.openTopBarMenu(event)
    });

    // 独立日程面板：在标签页里放大显示同一套挂件（mode=panel）。
    // 使用 SiYuan 的 flex 填充类，让 iframe 从确定高度的标签页取得高度，避免 height:100% 反馈膨胀。
    this.addTab({
      type: PANEL_TAB,
      init() {
        this.element.innerHTML = `<div class="fn__flex fn__flex-column fn__flex-1">
          <iframe class="fn__flex-1" allowfullscreen src="/plugins/schedule-block/widget/index.html?mode=panel&view=month"
            style="border:0;width:100%;min-height:0;display:block;background:transparent;"></iframe>
        </div>`;
      }
    });

    this.protyleSlash = VIEWS.map((view) => ({
      id: `schedule-block-${view}`,
      filter: [BLOCK_LABEL[view], "calendar", ...VIEW_PINYIN[view]],
      html: `<div class="b3-list-item__first"><svg class="b3-list-item__graphic"><use xlink:href="#iconCalendarBlock"></use></svg><span class="b3-list-item__text">插入${BLOCK_LABEL[view]}</span></div>`,
      callback: (protyle: Protyle, nodeElement: HTMLElement) => {
        this.insertFromSlash(view, protyle, nodeElement);
      }
    }));

    VIEWS.forEach((view) => {
      this.addCommand({
        langKey: `insertCalendarBlock-${view}`,
        langText: `插入${BLOCK_LABEL[view]}`,
        hotkey: "",
        callback: () => this.insertAtCursor(view)
      });
    });

    this.addCommand({
      langKey: "scheduleQuickAdd",
      langText: "添加日程",
      hotkey: "⌥⌘S",
      callback: () => this.openQuickAdd()
    });
    this.addCommand({
      langKey: "scheduleOpenPanel",
      langText: "打开日程面板",
      hotkey: "⌥⇧⌘S",
      callback: () => this.openPanel()
    });

    try {
      this.uiChannel = new BroadcastChannel("schedule-block-ui");
      this.uiChannel.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.type === "quickadd-saved") {
          showMessage(msg.text || "已记录日程", 3000);
          this.closeQuickAdd();
        } else if (msg.type === "quickadd-cancel") {
          this.closeQuickAdd();
        } else if (msg.type === "quickadd-open") {
          this.openQuickAdd();
        }
      };
    } catch {
      this.uiChannel = null;
    }
  }

  onunload() {
    this.uiChannel?.close();
    this.closeQuickAdd();
  }

  private openQuickAdd() {
    this.closeQuickAdd();
    this.quickDialog = new Dialog({
      title: "",
      content: `<iframe src="/plugins/schedule-block/widget/index.html?view=quickadd"
        style="width:100%;height:326px;border:0;display:block;border-radius:8px;" allowfullscreen></iframe>`,
      width: "374px",
      destroyCallback: () => {
        this.quickDialog = null;
      }
    });
  }

  private closeQuickAdd() {
    if (this.quickDialog) {
      this.quickDialog.destroy();
      this.quickDialog = null;
    }
  }

  private openPanel() {
    openTab({
      app: this.app,
      custom: {
        id: this.name + PANEL_TAB,
        icon: "iconCalendarBlock",
        title: "日程",
        data: {}
      }
    });
  }

  private openTopBarMenu(event: MouseEvent) {
    this.lastContext = getCurrentContext();
    const menu = new Menu("schedule-block-topbar");
    menu.addItem({
      icon: "iconCalendarBlock",
      label: "添加日程",
      click: () => this.openQuickAdd()
    });
    VIEWS.forEach((view) => {
      menu.addItem({
        icon: "iconCalendarBlock",
        label: `插入${BLOCK_LABEL[view]}`,
        click: () => this.insertAtCursor(view, this.lastContext)
      });
    });
    menu.addSeparator();
    menu.addItem({
      icon: "iconCalendarBlock",
      label: "打开日程面板",
      click: () => this.openPanel()
    });
    const rect = this.menuAnchorRect(event);
    menu.open({
      x: rect.left,
      y: rect.bottom,
      w: rect?.width,
      h: rect?.height
    });
  }

  private menuAnchorRect(event: MouseEvent): DOMRect {
    if (event.clientX > 0 && event.clientY > 0) {
      const size = 28;
      return new DOMRect(event.clientX - size / 2, event.clientY - size / 2, size, size);
    }
    const target = event.target instanceof Element
      ? event.target.closest("button,[data-type],.toolbar__item,.b3-menu__item") || event.target
      : null;
    const candidates = [
      target,
      event.currentTarget instanceof Element ? event.currentTarget : null,
      this.topBarElement || null,
      this.findPluginMenuAnchor()
    ];
    for (const el of candidates) {
      const rect = el?.getBoundingClientRect();
      if (rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0) {
        return rect;
      }
    }
    const fallbackSize = 28;
    return new DOMRect(Math.max(window.innerWidth - fallbackSize - 12, 0), 8, fallbackSize, fallbackSize);
  }

  private findPluginMenuAnchor(): HTMLElement | null {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(
      [
        ".toolbar__item",
        "button",
        "[data-type]"
      ].join(",")
    ));
    let best: { el: HTMLElement; score: number } | null = null;
    for (const el of candidates) {
      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0 || rect.right <= 0) {
        continue;
      }
      if (rect.top > 96 || rect.left < window.innerWidth / 2) {
        continue;
      }
      const label = [
        el.getAttribute("aria-label"),
        el.getAttribute("title"),
        el.getAttribute("data-type"),
        el.textContent
      ].filter(Boolean).join(" ").toLowerCase();
      const isPluginButton = label.includes("插件") || label.includes("plugin") || label.includes("plugins");
      const score = rect.right + (isPluginButton ? 10000 : 0);
      if (!best || score > best.score) {
        best = { el, score };
      }
    }
    return best?.el || null;
  }

  /** 斜杠菜单使用编辑器原生插入，避免先插入再延迟删除触发块造成闪烁 */
  private async insertFromSlash(view: ViewKey, protyle: Protyle, nodeElement: HTMLElement) {
    const context = contextFromProtyle(protyle, nodeElement);
    const date = await defaultDateForDoc(context.docID);
    try {
      protyle.insert(widgetMarkdown(view, date), true, true);
    } catch (err) {
      console.error("schedule-block: protyle.insert 失败，回退到内核插入", err);
      this.insertAtCursor(view, context);
    }
  }

  /** 在光标所在块下方插入挂件块；找不到光标时追加到当前文档末尾 */
  private async insertAtCursor(view: ViewKey, context = getCurrentContext()) {
    const docID = await resolveDocID(context);
    if (!docID) {
      showMessage("请先把光标放进文档", 5000, "error");
      return;
    }
    try {
      const previousID = context.blockID && context.blockID !== docID ? context.blockID : undefined;
      const date = await defaultDateForDoc(docID);
      const operations = await insertWidgetBlock(view, docID, date, previousID);
      const insertedID = operations?.[0]?.doOperations?.[0]?.id || "";
      if (isBlockID(insertedID)) {
        await post("/api/attr/setBlockAttrs", {
          id: insertedID,
          attrs: {
            style: "height: 1330px;",
            "custom-calendar-view": view,
            "custom-calendar-date": date
          }
        });
      }
    } catch (err) {
      showMessage(`插入失败：${err instanceof Error ? err.message : err}`, 6000, "error");
    }
  }
}

function widgetMarkdown(view: ViewKey, date = fmtDate(new Date())): string {
  const src = `/plugins/schedule-block/widget/index.html?view=${encodeURIComponent(view)}&date=${encodeURIComponent(date)}`;
  return `<iframe src="${src}" data-subtype="widget" border="0" frameborder="no" framespacing="0" allowfullscreen="true"></iframe>`;
}

async function insertWidgetBlock(view: ViewKey, docID: string, date: string, previousID?: string): Promise<BlockOperation[]> {
  const payload: any = {
    dataType: "markdown",
    data: widgetMarkdown(view, date),
    parentID: docID
  };
  if (previousID) {
    payload.previousID = previousID;
  }
  return post<BlockOperation[]>("/api/block/insertBlock", payload);
}

async function defaultDateForDoc(docID: string): Promise<string> {
  const today = fmtDate(new Date());
  if (!isBlockID(docID)) {
    return today;
  }
  try {
    const rows = await post<Array<{ content?: string }>>("/api/query/sql", {
      stmt: `SELECT content FROM blocks WHERE id='${docID}' LIMIT 1`
    });
    return parseDateFromTitle(rows?.[0]?.content || "") || today;
  } catch {
    return today;
  }
}

function post<T>(url: string, data?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    fetchPost(url, data, (response: ApiResponse<T>) => {
      if (response.code !== 0) {
        reject(new Error(response.msg || `${url} 调用失败`));
        return;
      }
      resolve(response.data);
    });
  });
}

async function resolveDocID(context: InsertContext): Promise<string> {
  const candidates = [context.blockID, context.docID].filter(isBlockID);
  for (const id of candidates) {
    const rows = await post<BlockRow[]>("/api/query/sql", {
      stmt: `SELECT id, root_id, type FROM blocks WHERE id='${id}' LIMIT 1`
    });
    const row = rows?.[0];
    if (!row) {
      continue;
    }
    if (row.type === "d" && isBlockID(row.id)) {
      return row.id;
    }
    if (isBlockID(row.root_id)) {
      return row.root_id;
    }
  }
  return "";
}

function contextFromProtyle(protyle: Protyle | undefined, nodeElement?: HTMLElement | null): InsertContext {
  const blockID = nodeElement?.dataset?.nodeId || "";
  const docID = protyle?.protyle?.block?.rootID || "";
  return {
    blockID: isBlockID(blockID) ? blockID : "",
    docID: isBlockID(docID) ? docID : ""
  };
}

function getCurrentContext(): InsertContext {
  let activeEditor: Protyle | undefined;
  try {
    activeEditor = getActiveEditor(false) || getAllEditor()?.[0];
  } catch {
    activeEditor = undefined;
  }
  const activeDocID = activeEditor?.protyle?.block?.rootID || "";
  const selectionBlockID = getCurrentBlockID(activeEditor);
  const activeBlockID = activeEditor?.protyle?.selectElement?.getAttribute("data-node-id") || "";
  const editorBlockID = activeEditor?.protyle?.block?.id || "";
  const blockID = [selectionBlockID, activeBlockID, editorBlockID].find(isBlockID) || "";
  return {
    blockID,
    docID: isBlockID(activeDocID) ? activeDocID : ""
  };
}

function getBlockIDFromRange(range: Range | null | undefined): string {
  if (!range) return "";
  const node = range.startContainer;
  const element = node instanceof Element ? node : node?.parentElement;
  const blockEl = element?.closest?.("[data-node-id]") as HTMLElement | null;
  const blockID = blockEl?.getAttribute("data-node-id") || "";
  return isBlockID(blockID) ? blockID : "";
}

function getCurrentBlockID(activeEditor?: any): string {
  if (activeEditor) {
    // 1. 尝试从 toolbar.range 获取（最可靠，失焦后依然保留最后的光标位置）
    const range = activeEditor.protyle?.toolbar?.range;
    const rangeBlockID = getBlockIDFromRange(range);
    if (isBlockID(rangeBlockID)) {
      return rangeBlockID;
    }

    // 2. 尝试从活跃编辑器的 DOM 中寻找带有活跃/选中等类名的块
    const wysiwyg = activeEditor.protyle?.wysiwyg?.element;
    if (wysiwyg) {
      const selectors = [
        ".protyle-wysiwyg--active",
        ".protyle-wysiwyg--select",
        "[contenteditable='true']:focus",
        ":focus-within"
      ];
      for (const selector of selectors) {
        const el = wysiwyg.querySelector(selector);
        const block = el?.closest("[data-node-id]");
        const blockID = block?.getAttribute("data-node-id") || "";
        if (isBlockID(blockID)) {
          return blockID;
        }
      }
    }

    // 3. 尝试从 selectElement 中获取
    const selectEl = activeEditor.protyle?.selectElement;
    const selectID = selectEl?.getAttribute("data-node-id") || "";
    if (isBlockID(selectID)) {
      return selectID;
    }

    // 4. 尝试从 block.id 中获取（若不是文档ID）
    const docID = activeEditor.protyle?.block?.rootID || "";
    const blockID = activeEditor.protyle?.block?.id || "";
    if (isBlockID(blockID) && blockID !== docID) {
      return blockID;
    }
  }

  // 5. 尝试从当前 window.getSelection() 获取选区
  const selection = window.getSelection();
  if (selection && selection.rangeCount > 0) {
    const selBlockID = getBlockIDFromRange(selection.getRangeAt(0));
    if (isBlockID(selBlockID)) {
      return selBlockID;
    }
  }

  // 6. 尝试从当前活动元素获取
  const active = document.activeElement instanceof HTMLElement
    ? (document.activeElement.closest("[data-node-id]") as HTMLElement | null)
    : null;
  const activeID = active?.dataset?.nodeId || "";
  return isBlockID(activeID) ? activeID : "";
}

function isBlockID(value: string): boolean {
  return /^\d{14}-[a-z0-9]{7}$/.test(value);
}
