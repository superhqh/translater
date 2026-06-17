const DEFAULT_SETTINGS = {
  apiKey: "",
  model: "gpt-4.1-mini",
  targetLanguage: "简体中文",
  autoTranslate: false,
  maxPageSegments: 40
};

const CACHE_STORAGE_KEY = "translationCache";
const SETTINGS_STORAGE_KEY = "settings";
const MAX_CACHE_ENTRIES = 500;

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  if (!settings) {
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS });
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "getSettings") {
    getSettings().then(sendResponse);
    return true;
  }

  if (message?.type === "saveSettings") {
    saveSettings(message.settings).then(sendResponse);
    return true;
  }

  if (message?.type === "translateText") {
    translateText(message.payload)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  }

  if (message?.type === "clearCache") {
    chrome.storage.local.remove(CACHE_STORAGE_KEY).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

async function getSettings() {
  const { settings } = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function saveSettings(nextSettings = {}) {
  const current = await getSettings();
  const settings = {
    ...current,
    apiKey: String(nextSettings.apiKey || "").trim(),
    model: String(nextSettings.model || DEFAULT_SETTINGS.model).trim(),
    targetLanguage: String(nextSettings.targetLanguage || DEFAULT_SETTINGS.targetLanguage).trim(),
    autoTranslate: Boolean(nextSettings.autoTranslate)
  };

  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
  return { ok: true, settings };
}

async function translateText(payload = {}) {
  const settings = await getSettings();
  const text = cleanInput(payload.text);
  const targetLanguage = payload.targetLanguage || settings.targetLanguage;
  const model = payload.model || settings.model;

  if (!text) {
    throw new Error("没有可翻译的文本。");
  }

  if (!settings.apiKey) {
    throw new Error("请先在插件弹窗里保存 OpenAI API Key。");
  }

  const cacheKey = makeCacheKey({ model, targetLanguage, text });
  const cached = await readCache(cacheKey);
  if (cached) {
    return { text: cached, cached: true };
  }

  const translated = await callOpenAI({
    apiKey: settings.apiKey,
    model,
    targetLanguage,
    text
  });

  await writeCache(cacheKey, translated);
  return { text: translated, cached: false };
}

async function callOpenAI({ apiKey, model, targetLanguage, text }) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      instructions: [
        "You are a precise translation engine.",
        `Translate the user's text into ${targetLanguage}.`,
        "Preserve meaning, tone, numbers, names, URLs, markdown, and inline code.",
        "Return only the translated text. Do not explain."
      ].join(" "),
      input: text
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = data?.error?.message || response.statusText || "OpenAI 请求失败。";
    throw new Error(detail);
  }

  const outputText = extractOutputText(data);
  if (!outputText) {
    throw new Error("OpenAI 返回结果里没有可用译文。");
  }

  return outputText.trim();
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string") {
    return data.output_text;
  }

  if (!Array.isArray(data?.output)) {
    return "";
  }

  return data.output
    .flatMap((item) => item?.content || [])
    .map((content) => content?.text || content?.value || "")
    .filter(Boolean)
    .join("\n");
}

function cleanInput(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

async function readCache(key) {
  const { [CACHE_STORAGE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_STORAGE_KEY);
  const hit = cache[key];
  if (!hit?.text) {
    return "";
  }

  hit.accessedAt = Date.now();
  await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
  return hit.text;
}

async function writeCache(key, text) {
  const { [CACHE_STORAGE_KEY]: cache = {} } = await chrome.storage.local.get(CACHE_STORAGE_KEY);
  cache[key] = {
    text,
    createdAt: Date.now(),
    accessedAt: Date.now()
  };

  const entries = Object.entries(cache);
  if (entries.length > MAX_CACHE_ENTRIES) {
    entries
      .sort((a, b) => (a[1].accessedAt || 0) - (b[1].accessedAt || 0))
      .slice(0, entries.length - MAX_CACHE_ENTRIES)
      .forEach(([oldKey]) => delete cache[oldKey]);
  }

  await chrome.storage.local.set({ [CACHE_STORAGE_KEY]: cache });
}

function makeCacheKey({ model, targetLanguage, text }) {
  return [model, targetLanguage, hashText(text)].join(":");
}

function hashText(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeError(error) {
  return error?.message || String(error || "未知错误");
}
