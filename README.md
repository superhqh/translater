# Local Immersive Translator

一个最小可用的 Chrome Manifest V3 翻译插件原型，核心功能包括：

- 网页正文段落识别
- 段落级双语译文插入
- 划词翻译弹窗
- 用户自定义 OpenAI API Key
- 本地翻译缓存

## 使用方式

1. 打开 Chrome 的 `chrome://extensions`。
2. 开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本目录：`F:\projects\translater`。
5. 点击插件图标，填入 OpenAI API Key、模型和目标语言。
6. 点击“翻译当前页”，或在网页中划词查看弹窗翻译。

## 当前默认配置

- API：OpenAI Responses API
- 默认模型：`gpt-4.1-mini`
- 默认目标语言：`简体中文`
- 默认最多翻译当前页前 40 个正文段落

## 说明

API Key 存在浏览器本地的 `chrome.storage.local` 中。这个原型适合个人使用和本地开发；如果要分发给其他用户，建议改成服务端代理、用户鉴权和用量控制，避免 API Key 暴露和滥用。

当前版本只做网页与划词翻译。PDF、视频字幕、术语库、多引擎 provider、站点规则和批量并发优化可以作为后续迭代。
