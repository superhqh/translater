const TRANSLATION_CLASS = "local-immersive-translation";
const INLINE_TRANSLATION_CLASS = "local-immersive-inline-translation";
const TRANSLATED_ATTR = "data-local-immersive-translated";
const ORIGINAL_TEXT_ATTR = "data-local-immersive-original";
const MIN_TEXT_LENGTH = 2;
const MAX_TEXT_LENGTH = 4000;
const PAGE_TRANSLATION_CONCURRENCY = 1;
const PAGE_BLOCK_BATCH_SIZE = 30;
const PAGE_TRANSLATION_BATCH_MAX_CHARS = 12000;
const DEFAULT_MAX_TRANSLATION_UNITS = 250;

const MAIN_CONTENT_SELECTOR = [
  "main article",
  "[role='main'] article",
  "article",
  "main [data-pagefind-body]",
  "main [data-mdx-content]",
  "main .prose",
  "[role='main'] [data-pagefind-body]",
  "[role='main'] .prose",
  "main",
  "[role='main']"
].join(",");

const BLOCK_CONTAINER_SELECTOR = [
  "p",
  "li",
  "blockquote",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "figcaption",
  "dt",
  "dd"
].join(",");

const EXCLUDED_ANCESTOR_SELECTOR = [
  `.${TRANSLATION_CLASS}`,
  `.${INLINE_TRANSLATION_CLASS}`,
  "script",
  "style",
  "noscript",
  "header",
  "nav",
  "aside",
  "footer",
  "dialog",
  "pre",
  "code",
  "kbd",
  "samp",
  "textarea",
  "input",
  "select",
  "option",
  "svg",
  "canvas",
  "[role='navigation']",
  "[role='dialog']",
  "[role='menu']",
  "[role='menubar']",
  "[aria-modal='true']",
  "[aria-hidden='true']",
  "[hidden]"
].join(",");

const EXCLUDED_DYNAMIC_SELECTOR = [
  "[class*='cookie' i]",
  "[id*='cookie' i]",
  "[class*='consent' i]",
  "[id*='consent' i]",
  "[class*='modal' i]",
  "[id*='modal' i]",
  "[class*='popover' i]",
  "[id*='popover' i]",
  "[class*='toast' i]",
  "[id*='toast' i]",
  "[class*='tooltip' i]",
  "[id*='tooltip' i]",
  "[class*='sidebar' i]",
  "[id*='sidebar' i]",
  "[class*='side-nav' i]",
  "[id*='side-nav' i]",
  "[class*='toc' i]",
  "[id*='toc' i]",
  "[class*='table-of-contents' i]",
  "[id*='table-of-contents' i]",
  "[class*='search' i]",
  "[id*='search' i]"
].join(",");

const LOCAL_ZH_TRANSLATIONS = new Map(
  Object.entries({
    search: "搜索",
    "copy page": "复制页面",
    navigation: "导航",
    previous: "上一页",
    next: "下一页",
    english: "英语",
    yes: "是",
    no: "否",
    on: "开启",
    off: "关闭",
    open: "打开",
    close: "关闭",
    copy: "复制",
    copied: "已复制",
    save: "保存",
    cancel: "取消",
    edit: "编辑",
    delete: "删除",
    back: "返回",
    menu: "菜单",
    settings: "设置",
    docs: "文档",
    home: "首页",
    overview: "概览",
    "core concepts": "核心概念",
    "start session": "开始会话",
    "learn more": "了解更多",
    "key takeaway": "关键要点",
    "in your terminal you see": "你会在终端中看到",
    system: "系统",
    memory: "记忆",
    skills: "技能",
    rules: "规则",
    files: "文件",
    output: "输出",
    hooks: "钩子"
  })
);

let isPageTranslating = false;
let selectionPopover = null;
let selectionAction = null;
let pendingSelectionText = "";
let pendingSelectionRect = null;
let restoreRecords = [];
let translationRecords = [];
let currentTranslationMode = "bilingual";

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

  if (message?.type === "setTranslationMode") {
    const result = setTranslationMode(message.mode);
    sendResponse({ ok: true, ...result });
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
  const mode = settings.translationMode || "bilingual";
  currentTranslationMode = mode;
  const contentRoot = findMainContentRoot();
  const units = collectTranslationUnits(contentRoot, settings.maxPageSegments || DEFAULT_MAX_TRANSLATION_UNITS, mode);
  prepareTranslationUnits(units, mode);
  const requestItems = applyLocalAndBuildRequests(units, settings);
  const batches = createRequestBatches(requestItems);

  try {
    await runLimitedConcurrency(batches, PAGE_TRANSLATION_CONCURRENCY, (batch) => translateRequestBatch(batch, settings));
  } catch (error) {
    clearLoadingPlaceholders();
    throw error;
  } finally {
    isPageTranslating = false;
  }

  return { count: units.length };
}

function collectTranslationUnits(root, limit, mode) {
  const textNodes = collectVisibleEnglishTextNodes(root, limit * 10);

  const blockUnitsByContainer = new Map();
  const inlineUnits = [];

  for (const item of textNodes) {
    const container = findBlockContainer(item.node);
    if (container) {
      const existing = blockUnitsByContainer.get(container);
      if (existing) {
        existing.nodes.push(item.node);
        existing.text = getElementText(container);
        existing.priority = Math.min(existing.priority, getPriority(container));
        continue;
      }

      blockUnitsByContainer.set(container, {
        id: createUnitId(),
        kind: "block",
        context: "page",
        mode,
        container,
        nodes: [item.node],
        text: getElementText(container),
        priority: getPriority(container),
        order: item.order,
        placeholder: null
      });
      continue;
    }

    inlineUnits.push(createTextUnit({ node: item.node, text: item.text, order: item.order, mode }));
  }

  return [...blockUnitsByContainer.values(), ...inlineUnits]
    .filter((unit) => isTranslatableText(unit.text))
    .sort((a, b) => a.order - b.order)
    .slice(0, limit);
}

function collectVisibleEnglishTextNodes(root, maxNodes) {
  const nodes = [];
  let order = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || nodes.length >= maxNodes) {
        return NodeFilter.FILTER_REJECT;
      }

      const text = normalizeVisibleText(node.data);
      if (!isTranslatableText(text)) {
        return NodeFilter.FILTER_REJECT;
      }

      if (!isAllowedTextNode(node)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (nodes.length < maxNodes) {
    const node = walker.nextNode();
    if (!node) {
      break;
    }
    nodes.push({
      node,
      text: normalizeVisibleText(node.data),
      order
    });
    order += 1;
  }

  return nodes;
}

function createTextUnit({ node, text, order, mode }) {
  const parent = node.parentElement;
  const inline = isShortUiText(node, text);
  return {
    id: createUnitId(),
    kind: inline ? "inline" : "text",
    context: "page",
    mode,
    node,
    text,
    priority: getPriority(parent),
    order,
    placeholder: null
  };
}

function prepareTranslationUnits(units, mode) {
  for (const unit of units) {
    if (unit.kind === "block") {
      unit.container.setAttribute(TRANSLATED_ATTR, "true");
      unit.placeholder = createBlockPlaceholder();
      unit.container.insertAdjacentElement("afterend", unit.placeholder);
      continue;
    }

    const parent = unit.node.parentElement;
    parent?.setAttribute(TRANSLATED_ATTR, "true");

    if (mode === "replace") {
      rememberOriginalTextNode(unit.node);
      continue;
    }

    unit.placeholder = createInlinePlaceholder();
    unit.node.parentNode?.insertBefore(unit.placeholder, unit.node.nextSibling);
  }
}

function applyLocalAndBuildRequests(units, settings) {
  const requestItemsByKey = new Map();

  for (const unit of units) {
    const localTranslation = getLocalTranslation(unit.text, settings.targetLanguage);
    if (localTranslation) {
      applyTranslation(unit, localTranslation, true);
      continue;
    }

    if (shouldSkipApiTranslation(unit.text)) {
      applySkippedTranslation(unit);
      continue;
    }

    const normalizedText = normalizeCacheText(unit.text);
    const key = `${unit.context}:${normalizedText}`;
    let item = requestItemsByKey.get(key);
    if (!item) {
      item = {
        id: createUnitId(),
        context: unit.context,
        text: normalizedText,
        units: []
      };
      requestItemsByKey.set(key, item);
    }
    item.units.push(unit);
  }

  return [...requestItemsByKey.values()].sort((a, b) => {
    const firstA = a.units[0];
    const firstB = b.units[0];
    return firstA.order - firstB.order;
  });
}

function createRequestBatches(items) {
  const batches = [];
  let currentBatch = [];
  let currentChars = 0;
  let currentContext = "";

  for (const item of items) {
    const shouldStartNewBatch =
      currentBatch.length > 0 &&
      (currentContext !== item.context ||
        currentBatch.length >= PAGE_BLOCK_BATCH_SIZE ||
        currentChars + item.text.length > PAGE_TRANSLATION_BATCH_MAX_CHARS);

    if (shouldStartNewBatch) {
      batches.push({ context: currentContext, items: currentBatch });
      currentBatch = [];
      currentChars = 0;
    }

    currentContext = item.context;
    currentBatch.push(item);
    currentChars += item.text.length;
  }

  if (currentBatch.length > 0) {
    batches.push({ context: currentContext, items: currentBatch });
  }

  return batches;
}

async function translateRequestBatch(batch, settings) {
  if (batch.items.length === 0) {
    return;
  }

  try {
    const response = await sendMessage({
      type: "translateBatch",
      payload: {
        context: batch.context,
        segments: batch.items.map((item) => ({
          id: item.id,
          text: item.text
        })),
        model: settings.model,
        targetLanguage: settings.targetLanguage
      }
    });

    if (!response.ok) {
      throw createTranslationError(response.error || "批量翻译失败");
    }

    const translations = response.translations || {};
    const fallbackItems = [];

    for (const item of batch.items) {
      const translatedText = translations[item.id];
      if (typeof translatedText === "string" && translatedText.trim()) {
        for (const unit of item.units) {
          applyTranslation(unit, translatedText, Boolean(response.cached?.[item.id]));
        }
      } else {
        fallbackItems.push(item);
      }
    }

    await translateMissingItems(fallbackItems, settings);
  } catch (error) {
    if (isRateLimitError(error)) {
      applyPageLevelError(batch, "Kimi 当前繁忙或触发限速，已暂停全文翻译。请稍后重试。");
      throw new Error("Kimi 当前繁忙或触发限速，已暂停全文翻译。请稍后重试。");
    }

    if (batch.items.length > 1) {
      const middle = Math.ceil(batch.items.length / 2);
      await translateRequestBatch({ context: batch.context, items: batch.items.slice(0, middle) }, settings);
      await translateRequestBatch({ context: batch.context, items: batch.items.slice(middle) }, settings);
      return;
    }

    await translateRequestItem(batch.items[0], settings);
  }
}

async function translateMissingItems(items, settings) {
  if (items.length === 0) {
    return;
  }

  if (items.length <= 2) {
    await runLimitedConcurrency(items, 1, (item) => translateRequestItem(item, settings));
    return;
  }

  const middle = Math.ceil(items.length / 2);
  await translateRequestBatch({ context: items[0].context, items: items.slice(0, middle) }, settings);
  await translateRequestBatch({ context: items[0].context, items: items.slice(middle) }, settings);
}

async function translateRequestItem(item, settings) {
  try {
    const response = await sendMessage({
      type: "translateText",
      payload: {
        text: item.text,
        context: "page",
        model: settings.model,
        targetLanguage: settings.targetLanguage
      }
    });

    if (!response.ok) {
      throw createTranslationError(response.error || "翻译失败");
    }

    for (const unit of item.units) {
      applyTranslation(unit, response.text, response.cached);
    }
  } catch (error) {
    if (isRateLimitError(error)) {
      const message = "Kimi 当前繁忙或触发限速，已暂停全文翻译。请稍后重试。";
      applyPageLevelError({ items: [item] }, message);
      throw new Error(message);
    }

    for (const unit of item.units) {
      applyError(unit, error.message);
    }
  }
}

function applyTranslation(unit, text, cached = false) {
  const record = getOrCreateTranslationRecord(unit);
  record.translatedText = text;
  record.cached = cached;
  renderTranslationRecord(record, currentTranslationMode);
}

function getOrCreateTranslationRecord(unit) {
  let record = translationRecords.find((item) => item.id === unit.id);
  if (record) {
    record.placeholder = unit.placeholder || record.placeholder;
    return record;
  }

  record = {
    id: unit.id,
    kind: unit.kind,
    mode: null,
    translatedText: "",
    cached: false,
    placeholder: unit.placeholder || null
  };

  if (unit.kind === "block") {
    record.container = unit.container;
    record.originalChildNodes = null;
    record.originalText = getElementText(unit.container);
  } else {
    record.node = unit.node;
    record.parent = unit.node.parentNode;
    record.nextSibling = unit.node.nextSibling;
    record.originalText = unit.node.data;
  }

  translationRecords.push(record);
  return record;
}

function renderTranslationRecord(record, mode) {
  if (!record.translatedText) {
    return;
  }

  restoreRecordOriginal(record);
  removeRecordPlaceholder(record);

  if (mode === "replace") {
    renderRecordAsReplacement(record);
  } else {
    renderRecordAsBilingual(record);
  }

  record.mode = mode;
}

function renderRecordAsReplacement(record) {
  if (record.kind === "block") {
    if (!record.container?.isConnected) {
      return;
    }

    captureBlockOriginalChildren(record);
    record.container.textContent = record.translatedText;
    record.container.setAttribute(TRANSLATED_ATTR, "true");
    record.container.setAttribute(ORIGINAL_TEXT_ATTR, "true");
    return;
  }

  if (!record.node?.isConnected) {
    return;
  }

  record.node.data = record.translatedText;
  record.node.parentElement?.setAttribute(TRANSLATED_ATTR, "true");
  record.node.parentElement?.setAttribute(ORIGINAL_TEXT_ATTR, "true");
}

function renderRecordAsBilingual(record) {
  if (record.kind === "block") {
    if (!record.container?.isConnected) {
      return;
    }

    const placeholder = record.placeholder || createBlockPlaceholder();
    record.placeholder = placeholder;
    placeholder.classList.remove("is-loading", "is-error");
    placeholder.textContent = record.translatedText;
    if (record.cached) {
      placeholder.dataset.cached = "true";
    } else {
      delete placeholder.dataset.cached;
    }
    record.container.insertAdjacentElement("afterend", placeholder);
    record.container.setAttribute(TRANSLATED_ATTR, "true");
    return;
  }

  if (!record.node?.isConnected) {
    return;
  }

  const placeholder = record.placeholder || createInlinePlaceholder();
  record.placeholder = placeholder;
  placeholder.classList.remove("is-loading", "is-error");
  placeholder.textContent = record.translatedText;
  if (record.cached) {
    placeholder.dataset.cached = "true";
  } else {
    delete placeholder.dataset.cached;
  }
  record.node.parentNode?.insertBefore(placeholder, record.node.nextSibling);
  record.node.parentElement?.setAttribute(TRANSLATED_ATTR, "true");
}

function restoreRecordOriginal(record) {
  if (record.kind === "block") {
    if (!record.container?.isConnected) {
      return;
    }

    if (record.originalChildNodes) {
      record.container.replaceChildren(...record.originalChildNodes);
    }
    record.container.removeAttribute(ORIGINAL_TEXT_ATTR);
    return;
  }

  if (record.node?.isConnected) {
    record.node.data = record.originalText;
    record.node.parentElement?.removeAttribute(ORIGINAL_TEXT_ATTR);
  }
}

function captureBlockOriginalChildren(record) {
  if (!record.originalChildNodes && record.container) {
    record.originalChildNodes = Array.from(record.container.childNodes);
  }
}

function removeRecordPlaceholder(record) {
  record.placeholder?.remove();
  record.placeholder = null;
}

function applyError(unit, message) {
  if (unit.mode === "replace") {
    return;
  }

  if (!unit.placeholder) {
    return;
  }

  unit.placeholder.classList.remove("is-loading");
  unit.placeholder.classList.add("is-error");
  unit.placeholder.textContent = message;
}

function applyPageLevelError(batch, message) {
  const firstUnit = batch.items.flatMap((item) => item.units)[0];
  if (firstUnit) {
    applyError(firstUnit, message);
  }

  for (const item of batch.items) {
    for (const unit of item.units) {
      if (unit !== firstUnit) {
        removeUnitPlaceholder(unit);
      }
    }
  }
}

function clearLoadingPlaceholders() {
  document
    .querySelectorAll(`.${TRANSLATION_CLASS}.is-loading, .${INLINE_TRANSLATION_CLASS}.is-loading`)
    .forEach((element) => element.remove());
}

function applySkippedTranslation(unit) {
  if (unit.mode === "replace") {
    return;
  }

  removeUnitPlaceholder(unit);
}

function removeUnitPlaceholder(unit) {
  unit.placeholder?.remove();
  unit.placeholder = null;
}

async function runLimitedConcurrency(items, limit, worker) {
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);
  const runners = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await worker(item);
    }
  });

  await Promise.all(runners);
}

function isAllowedTextNode(node) {
  const parent = node.parentElement;
  if (!parent) {
    return false;
  }

  if (parent.closest(EXCLUDED_ANCESTOR_SELECTOR) || parent.closest(EXCLUDED_DYNAMIC_SELECTOR)) {
    return false;
  }

  if (parent.closest(`[${TRANSLATED_ATTR}]`)) {
    return false;
  }

  if (!isElementVisible(parent)) {
    return false;
  }

  if (looksLikeCodeBlock(parent.innerText || node.data)) {
    return false;
  }

  return true;
}

function findMainContentRoot() {
  const explicitCandidates = [...document.querySelectorAll(MAIN_CONTENT_SELECTOR)]
    .filter((element) => element instanceof HTMLElement && isMainContentCandidate(element));
  const explicitRoot = chooseBestContentRoot(explicitCandidates);
  if (explicitRoot) {
    return explicitRoot;
  }

  const fallbackCandidates = [
    ...document.querySelectorAll("main, article, [role='main'], section, [class*='content' i], [class*='article' i], [class*='prose' i], [class*='docs' i]")
  ].filter((element) => element instanceof HTMLElement && isMainContentCandidate(element));

  return chooseBestContentRoot(fallbackCandidates) || document.body;
}

function chooseBestContentRoot(candidates) {
  let best = null;
  let bestScore = 0;

  for (const candidate of candidates) {
    const score = getReadableContentScore(candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return bestScore >= 120 ? best : null;
}

function isMainContentCandidate(element) {
  if (element === document.body || element === document.documentElement) {
    return false;
  }

  if (!isElementVisible(element)) {
    return false;
  }

  if (element.matches(EXCLUDED_ANCESTOR_SELECTOR) || element.matches(EXCLUDED_DYNAMIC_SELECTOR)) {
    return false;
  }

  return !element.closest(`header, nav, aside, footer, [role='navigation'], [role='dialog'], [aria-modal='true'], ${EXCLUDED_DYNAMIC_SELECTOR}`);
}

function getReadableContentScore(element) {
  let score = 0;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) {
        return NodeFilter.FILTER_REJECT;
      }

      if (parent.closest(EXCLUDED_ANCESTOR_SELECTOR) || parent.closest(EXCLUDED_DYNAMIC_SELECTOR)) {
        return NodeFilter.FILTER_REJECT;
      }

      const text = normalizeVisibleText(node.data);
      if (!isTranslatableText(text) || shouldSkipApiTranslation(text)) {
        return NodeFilter.FILTER_REJECT;
      }

      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (score < 50000) {
    const node = walker.nextNode();
    if (!node) {
      break;
    }
    score += normalizeVisibleText(node.data).length;
  }

  return score;
}

function isElementVisible(element) {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
    return false;
  }

  return element.getClientRects().length > 0;
}

function findBlockContainer(node) {
  const parent = node.parentElement;
  if (!parent) {
    return null;
  }

  const semantic = parent.closest(BLOCK_CONTAINER_SELECTOR);
  if (semantic && !semantic.closest(EXCLUDED_ANCESTOR_SELECTOR) && !semantic.closest(EXCLUDED_DYNAMIC_SELECTOR)) {
    return semantic;
  }

  let current = parent;
  while (current && current !== document.body) {
    if (current.matches("main, article, section")) {
      return null;
    }

    const text = getElementText(current);
    const style = window.getComputedStyle(current);
    if (
      text.length >= 24 &&
      text.length <= MAX_TEXT_LENGTH &&
      style.display !== "inline" &&
      current.querySelectorAll(BLOCK_CONTAINER_SELECTOR).length === 0
    ) {
      return current;
    }

    current = current.parentElement;
  }

  return null;
}

function isShortUiText(node, text) {
  const parent = node.parentElement;
  if (!parent) {
    return false;
  }

  if (text.length <= 80 && parent.closest("button, a, summary, label, [role='button'], [role='tab'], [role='menuitem']")) {
    return true;
  }

  const style = window.getComputedStyle(parent);
  return text.length <= 50 && ["inline", "inline-block", "inline-flex"].includes(style.display);
}

function getPriority(element) {
  if (!element) {
    return 3;
  }

  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  if (rect.bottom >= 0 && rect.top <= viewportHeight) {
    return 0;
  }
  if (rect.top < viewportHeight + 1200 && rect.bottom > -1200) {
    return 1;
  }
  return 2;
}

function createBlockPlaceholder() {
  const placeholder = document.createElement("div");
  placeholder.className = `${TRANSLATION_CLASS} is-loading`;
  placeholder.textContent = "正在翻译...";
  return placeholder;
}

function createInlinePlaceholder() {
  const placeholder = document.createElement("span");
  placeholder.className = `${INLINE_TRANSLATION_CLASS} is-loading`;
  placeholder.textContent = " 正在翻译...";
  return placeholder;
}

function rememberOriginalTextNode(node) {
  if (restoreRecords.some((record) => record.node === node)) {
    return;
  }

  restoreRecords.push({
    node,
    text: node.data
  });
  node.parentElement?.setAttribute(ORIGINAL_TEXT_ATTR, "true");
}

function clearTranslations() {
  for (const record of translationRecords) {
    restoreRecordOriginal(record);
    removeRecordPlaceholder(record);
  }
  translationRecords = [];

  document.querySelectorAll(`.${TRANSLATION_CLASS}, .${INLINE_TRANSLATION_CLASS}`).forEach((element) => element.remove());

  for (const record of restoreRecords) {
    if (record.node.isConnected) {
      record.node.data = record.text;
    }
  }
  restoreRecords = [];

  document.querySelectorAll(`[${TRANSLATED_ATTR}]`).forEach((element) => {
    element.removeAttribute(TRANSLATED_ATTR);
  });
  document.querySelectorAll(`[${ORIGINAL_TEXT_ATTR}]`).forEach((element) => {
    element.removeAttribute(ORIGINAL_TEXT_ATTR);
  });
}

function setTranslationMode(mode) {
  if (!["bilingual", "replace"].includes(mode)) {
    return { count: translationRecords.length, switched: false };
  }

  currentTranslationMode = mode;
  const completedRecords = translationRecords.filter((record) => record.translatedText);
  for (const record of completedRecords) {
    renderTranslationRecord(record, mode);
  }

  return {
    count: completedRecords.length,
    switched: completedRecords.length > 0
  };
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

function getLocalTranslation(text, targetLanguage) {
  if (!/中文|chinese|zh/i.test(targetLanguage || "")) {
    return "";
  }

  return LOCAL_ZH_TRANSLATIONS.get(text.trim().toLowerCase()) || "";
}

function shouldSkipApiTranslation(text) {
  const normalized = normalizeCacheText(text);
  return (
    normalized.length < MIN_TEXT_LENGTH ||
    /^[\W_]+$/.test(normalized) ||
    /^[/\\$`>-]?\s*[\w.-]+(?:[/\\][\w.-]+)+$/.test(normalized) ||
    /^[-/]{1,2}[\w-]+(?:[=\s][\w.-]+)?$/.test(normalized) ||
    /^[A-Z]?\d+(?:\.\d+){1,3}$/.test(normalized)
  );
}

function isTranslatableText(text) {
  const normalized = normalizeVisibleText(text);
  return normalized.length >= MIN_TEXT_LENGTH && /[A-Za-z]/.test(normalized);
}

function normalizeVisibleText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCacheText(text) {
  return normalizeVisibleText(text);
}

function getElementText(element) {
  return normalizeVisibleText(element.innerText || element.textContent || "");
}

function createUnitId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function createTranslationError(message) {
  const error = new Error(message);
  error.isRateLimit = isRateLimitMessage(message);
  return error;
}

function isRateLimitError(error) {
  return Boolean(error?.isRateLimit) || isRateLimitMessage(error?.message);
}

function isRateLimitMessage(message) {
  return /429|rate\s*limit|too many requests|overloaded|currently overloaded|请求过于频繁|限速|繁忙/i.test(String(message || ""));
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
