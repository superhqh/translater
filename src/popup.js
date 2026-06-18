const fields = {
  apiKey: document.querySelector("#apiKey"),
  model: document.querySelector("#model"),
  targetLanguage: document.querySelector("#targetLanguage"),
  translationMode: document.querySelector("#translationMode"),
  autoTranslate: document.querySelector("#autoTranslate"),
  message: document.querySelector("#message"),
  statusDot: document.querySelector("#statusDot")
};

document.querySelector("#save").addEventListener("click", saveSettings);
document.querySelector("#translatePage").addEventListener("click", translateCurrentPage);
document.querySelector("#clearTranslations").addEventListener("click", clearTranslations);
document.querySelector("#clearCache").addEventListener("click", clearCache);

loadSettings();

async function loadSettings() {
  const settings = await sendRuntimeMessage({ type: "getSettings" });
  fields.apiKey.value = settings.apiKey || "";
  fields.model.value = settings.model || "kimi-k2.6";
  fields.targetLanguage.value = settings.targetLanguage || "简体中文";
  fields.translationMode.value = settings.translationMode || "bilingual";
  fields.autoTranslate.checked = Boolean(settings.autoTranslate);
  updateKeyState(Boolean(settings.apiKey));
}

async function saveSettings() {
  const response = await sendRuntimeMessage({
    type: "saveSettings",
    settings: {
      apiKey: fields.apiKey.value,
      model: fields.model.value,
      targetLanguage: fields.targetLanguage.value,
      translationMode: fields.translationMode.value,
      autoTranslate: fields.autoTranslate.checked
    }
  });

  updateKeyState(Boolean(response.settings?.apiKey));
  showMessage("设置已保存。");
}

async function translateCurrentPage() {
  await ensureSettingsSaved();
  const tab = await getActiveTab();
  const response = await sendTabMessage(tab.id, { type: "translatePage" });

  if (!response?.ok) {
    showMessage(response?.error || "无法翻译当前页。", true);
    return;
  }

  if (response.skipped) {
    showMessage("当前页正在翻译中。");
    return;
  }

  showMessage(`已提交 ${response.count} 个段落翻译。`);
}

async function clearTranslations() {
  const tab = await getActiveTab();
  const response = await sendTabMessage(tab.id, { type: "clearTranslations" });
  showMessage(response?.ok ? "当前页译文已清除。" : "无法清除当前页译文。", !response?.ok);
}

async function clearCache() {
  const response = await sendRuntimeMessage({ type: "clearCache" });
  showMessage(response?.ok ? "翻译缓存已清空。" : "清空缓存失败。", !response?.ok);
}

async function ensureSettingsSaved() {
  await sendRuntimeMessage({
    type: "saveSettings",
    settings: {
      apiKey: fields.apiKey.value,
      model: fields.model.value,
      targetLanguage: fields.targetLanguage.value,
      translationMode: fields.translationMode.value,
      autoTranslate: fields.autoTranslate.checked
    }
  });
}

function updateKeyState(hasKey) {
  fields.statusDot.classList.toggle("is-ready", hasKey);
}

function showMessage(text, isError = false) {
  fields.message.textContent = text;
  fields.message.classList.toggle("is-error", isError);
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    throw new Error("没有可用的当前标签页。");
  }
  return tab;
}

function sendRuntimeMessage(message) {
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

function sendTabMessage(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      resolve(response);
    });
  });
}
