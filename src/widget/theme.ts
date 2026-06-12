/** 把宿主（思源主窗口）的主题 CSS 变量镜像到 iframe 内，并跟随明暗切换 */

const VARS = [
  "--b3-font-family",
  "--b3-theme-primary",
  "--b3-theme-primary-light",
  "--b3-theme-primary-lighter",
  "--b3-theme-primary-lightest",
  "--b3-theme-background",
  "--b3-theme-background-light",
  "--b3-theme-surface",
  "--b3-theme-surface-light",
  "--b3-theme-surface-lighter",
  "--b3-theme-error",
  "--b3-theme-on-primary",
  "--b3-theme-on-background",
  "--b3-theme-on-surface",
  "--b3-theme-on-surface-light",
  "--b3-border-color",
  "--b3-list-hover",
  "--b3-scroll-color",
  "--b3-dialog-shadow"
];

export function initThemeBridge(): void {
  let parentDoc: Document | null = null;
  try {
    parentDoc = window.parent !== window ? window.parent.document : null;
  } catch {
    parentDoc = null;
  }
  if (!parentDoc) {
    return;
  }
  const parentWin = parentDoc.defaultView;
  if (!parentWin) {
    return;
  }

  const sync = () => {
    const computed = parentWin.getComputedStyle(parentDoc.documentElement);
    for (const name of VARS) {
      const value = computed.getPropertyValue(name);
      if (value) {
        document.documentElement.style.setProperty(name, value);
      }
    }
    const mode = parentDoc.documentElement.getAttribute("data-theme-mode");
    if (mode) {
      document.documentElement.setAttribute("data-theme-mode", mode);
    }
  };

  sync();
  let timer = 0;
  const observer = new MutationObserver(() => {
    window.clearTimeout(timer);
    timer = window.setTimeout(sync, 150);
  });
  observer.observe(parentDoc.documentElement, { attributes: true });
  // 主题包切换只换 head 里的样式表，再补一个兜底
  window.addEventListener("focus", sync);
}
