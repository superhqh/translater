const TRANSLATION_CLASS = "local-immersive-translation";
const TRANSLATED_ATTR = "data-local-immersive-translated";
const MIN_TEXT_LENGTH = 24;
const MAX_TEXT_LENGTH = 1800;

let isPageTranslating = false;
let selectionPopover = null;
let selectionAction = null;
let pendingSelectionText = "";
let pendingSelectionRect = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "translatePage") {
    translatePage()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message?.type === "clearTranslations") {
    clearTranslations();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

document.addEventListener("mousedown", handleSelectionMousedown, true);
document.addEventListener("mouseup", handleSelectionMouseup);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    removeSelectionUi();
  }
});

initAutoTranslate();

async function initAutoTranslate() {
  const settings = await sendMessage({ type: "getSettings" });
  if (settings.autoTranslate) {
    window.setTimeout(() => translatePage().catch(console.warn), 700);
  }
}

async function translatePage() {
  if (isPageTranslating) {
    return { count: 0, skipped: true };
  }

  isPageTranslating = true;
  const settings = await sendMessage({ type: "getSettings" });
  const candidates = collectReadableBlocks(settings.maxPageSegments || 40);
  let translatedCount = 0;

  try {
    for (const element of candidates) {
      await translateElement(element, settings);
      translatedCount += 1;
    }
  } finally {
    isPageTranslating = false;
  }

  return { count: translatedCount };
}

async function translateElement(element, settings) {
  if (element.getAttribute(TRANSLATED_ATTR) === "true") {
    return;
  }

  element.setAttribute(TRANSLATED_ATTR, "true");
  const placeholder = document.createElement("div");
  placeholder.className = `${TRANSLATION_CLASS} is-loading`;
  placeholder.textContent = "正在翻译...";
  element.insertAdjacentElement("afterend", placeholder);

  try {
    const response = await sendMessage({
      type: "translateText",
      payload: {
        text: getElementText(element),
        model: settings.model,
        targetLanguage: settings.targetLanguage
      }
    });

    if (!response.ok) {
      throw new Error(response.error || "翻译失败");
    }

    placeholder.classList.remove("is-loading");
    placeholder.textContent = response.text;
    if (response.cached) {
      placeholder.dataset.cached = "true";
    }
  } catch (error) {
    placeholder.classList.remove("is-loading");
    placeholder.classList.add("is-error");
    placeholder.textContent = error.message;
  }
}

function collectReadableBlocks(limit) {
  const selector = [
    "article p",
    "article li",
    "article blockquote",
    "main p",
    "main li",
    "main blockquote",
    "section p",
    "section li",
    "p",
    "li",
    "blockquote",
    "td",
    "th"
  ].join(",");

  const seenText = new Set();
  const elements = [];

  for (const element of document.querySelectorAll(selector)) {
    if (elements.length >= limit) {
      break;
    }

    if (!isReadableBlock(element)) {
      continue;
    }

    const text = getElementText(element);
    const fingerprint = text.slice(0, 160);
    if (seenText.has(fingerprint)) {
      continue;
    }

    seenText.add(fingerprint);
    elements.push(element);
  }

  return elements;
}

function isReadableBlock(element) {
  if (!(element instanceof HTMLElement)) {
    return false;
  }

  if (element.closest(`.${TRANSLATION_CLASS}, script, style, noscript, pre, code, textarea, input, select, button, nav, header, footer, aside, [class*="code"], [class*="Code"], [class*="syntax"], [class*="highlight"]`)) {
    return false;
  }

  if (element.getAttribute(TRANSLATED_ATTR) === "true") {
    return false;
  }

  const text = getElementText(element);
  if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) {
    return false;
  }

  if (looksLikeCodeBlock(element.innerText || text)) {
    return false;
  }

  const rect = element.getBoundingClientRect();
  if (rect.width < 80 || rect.height < 8) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  return true;
}

function looksLikeCodeBlock(text) {
  const lines = text.split(/\n|(?=<)/).filter((line) => line.trim());
  const codeIndicators = [
    /```/,
    /<!doctype\s+html/i,
    /<html[\s>]/i,
    /<\/?[a-z][\w:-]*(\s|>)/i,
    /;\s*$/,
    /^\s*(const|let|var|function|class|import|export)\s+/,
    /^\s*[.#]?[\w-]+\s*\{/,
    /=>/,
    /<\/script>|<script[\s>]/i,
    /<\/style>|<style[\s>]/i
  ];
  const codeLineCount = lines.filter((line) => codeIndicators.some((pattern) => pattern.test(line))).length;

  return codeLineCount >= 3 || codeLineCount / Math.max(lines.length, 1) > 0.35;
}

function getElementText(element) {
  return element.innerText.replace(/\s+/g, " ").trim();
}

function clearTranslations() {
  document.querySelectorAll(`.${TRANSLATION_CLASS}`).forEach((element) => element.remove());
  document.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach((element) => {
    element.removeAttribute(TRANSLATED_ATTR);
  });
}

function handleSelectionMousedown(event) {
  if (!(event.target instanceof Element)) {
    return;
  }

  if (event.target.closest(".local-immersive-selection-popover, .local-immersive-selection-action")) {
    return;
  }

  removeSelectionUi();
}

function handleSelectionMouseup(event) {
  if (event.target instanceof Element && event.target.closest(".local-immersive-selection-popover, .local-immersive-selection-action")) {
    return;
  }

  window.setTimeout(() => {
    const selection = window.getSelection();
    const text = selection?.toString().replace(/\s+/g, " ").trim();

    if (!text || text.length < 2 || text.length > 1200) {
      removeSelectionAction();
      return;
    }

    const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
    if (!range) {
      removeSelectionAction();
      return;
    }

    showSelectionAction(range, text);
  }, 80);
}

function showSelectionAction(range, text) {
  removeSelectionUi();

  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    return;
  }

  pendingSelectionText = text;
  pendingSelectionRect = rect;
  selectionAction = document.createElement("button");
  selectionAction.className = "local-immersive-selection-action";
  selectionAction.type = "button";
  selectionAction.title = "翻译选中文本";
  selectionAction.setAttribute("aria-label", "翻译选中文本");
  selectionAction.textContent = "译";
  selectionAction.addEventListener("mousedown", (event) => event.preventDefault());
  selectionAction.addEventListener("click", handleSelectionActionClick);
  document.documentElement.append(selectionAction);

  const top = Math.max(12, rect.bottom + window.scrollY + 8);
  const left = Math.min(
    window.scrollX + document.documentElement.clientWidth - selectionAction.offsetWidth - 12,
    Math.max(12, rect.right + window.scrollX - selectionAction.offsetWidth)
  );

  selectionAction.style.top = `${top}px`;
  selectionAction.style.left = `${left}px`;
}

async function handleSelectionActionClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const text = pendingSelectionText;
  const rect = selectionAction?.getBoundingClientRect() || pendingSelectionRect;
  if (!text || !rect) {
    removeSelectionUi();
    return;
  }

  removeSelectionAction();
  showSelectionPopoverAtRect(rect, "正在翻译...");

  try {
    const response = await sendMessage({
      type: "translateText",
      payload: {
        text,
        context: "selection"
      }
    });

    if (!response.ok) {
      throw new Error(response.error || "翻译失败");
    }

    updateSelectionPopover(response.text, response.cached);
  } catch (error) {
    updateSelectionPopover(error.message, false, true);
  }
}

function showSelectionPopoverAtRect(rect, text) {
  removeSelectionPopover();

  selectionPopover = document.createElement("div");
  selectionPopover.className = "local-immersive-selection-popover is-loading";
  selectionPopover.innerHTML = `
    <button class="local-immersive-selection-close" type="button" aria-label="关闭">×</button>
    <div class="local-immersive-selection-body"></div>
  `;
  selectionPopover.querySelector(".local-immersive-selection-body").textContent = text;
  selectionPopover.querySelector("button").addEventListener("click", removeSelectionPopover);
  document.documentElement.append(selectionPopover);

  const top = Math.max(12, rect.bottom + window.scrollY + 8);
  const left = Math.min(
    window.scrollX + document.documentElement.clientWidth - selectionPopover.offsetWidth - 12,
    Math.max(12, rect.left + window.scrollX)
  );

  selectionPopover.style.top = `${top}px`;
  selectionPopover.style.left = `${left}px`;
}

function updateSelectionPopover(text, cached = false, isError = false) {
  if (!selectionPopover) {
    return;
  }

  selectionPopover.classList.remove("is-loading", "is-error");
  if (isError) {
    selectionPopover.classList.add("is-error");
  }
  selectionPopover.dataset.cached = cached ? "true" : "false";
  selectionPopover.querySelector(".local-immersive-selection-body").textContent = text;
}

function removeSelectionPopover() {
  selectionPopover?.remove();
  selectionPopover = null;
}

function removeSelectionAction() {
  selectionAction?.remove();
  selectionAction = null;
  pendingSelectionText = "";
  pendingSelectionRect = null;
}

function removeSelectionUi() {
  removeSelectionAction();
  removeSelectionPopover();
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}
