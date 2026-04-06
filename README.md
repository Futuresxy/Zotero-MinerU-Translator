# Zotero MinerU Translator

[![Zotero 7](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org/)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero 7 插件，用于把 Zotero 中的 PDF 论文送到 MinerU 批量解析接口，提取 Markdown，再调用 OpenAI 兼容的大模型接口分段翻译，并把结果保存为 Zotero 笔记。

## 当前实现

1. 在 Zotero 条目右键菜单中增加 `翻译 PDF 并写入笔记`
2. 支持选中 PDF 附件，或选中包含 PDF 附件的父条目
3. 调用 MinerU `POST /api/v4/file-urls/batch` 申请上传链接
4. PUT 上传 PDF 文件，自动触发 MinerU 解析
5. 轮询 `GET /api/v4/extract-results/batch/{batch_id}`
6. 下载返回 zip，并提取 `full.md`
7. 跳过图片、表格、参考文献区块
8. 按字符数切分 Markdown
9. 调用 OpenAI 兼容 `POST /chat/completions`
10. 将译文 Markdown 作为 Zotero 子笔记保存

## 已支持的翻译提供方

- `openai`
- `deepseek`
- `doubao`
- `custom`

默认 Base URL：

- `openai` -> `https://api.openai.com/v1`
- `deepseek` -> `https://api.deepseek.com/v1`
- `doubao` -> `https://ark.cn-beijing.volces.com/api/v3`

说明：

- 插件现在同时支持 `.../chat/completions` 和 `.../responses`
- 如果你填写的是完整 endpoint，例如 `https://ark.cn-beijing.volces.com/api/v3/responses`，插件会直接按该地址请求，不再额外拼接路径

## 设置项

在 Zotero 中打开：

- `Tools -> Plugins -> Zotero MinerU Translator -> Preferences`

至少需要配置：

- `mineruApiToken`
- `translationProvider`
- `translationApiKey`
- `translationModel`

常用可选项：

- `mineruModelVersion`
- `translationBaseURL`
- `translationTargetLanguage`
- `translationChunkChars`
- `includeOriginalMarkdown`

## 可直接尝试的翻译配置

只需要填写对应的 Key 即可：

### 1. 火山方舟 Responses API

- `translationProvider` -> `volcano ark`
- `translationBaseURL` -> `https://ark.cn-beijing.volces.com/api/v3/responses`
- `translationModel` -> `doubao-seed-1-8-251228`

可选模型：

- `doubao-seed-1-8-251228`
- `doubao-1-5-pro-32k-250115`
- `doubao-pro-32k`

### 2. DeepSeek OpenAI Compatible API

- `translationProvider` -> `deepseek`
- `translationBaseURL` -> `https://api.deepseek.com/v1`
- `translationModel` -> `deepseek-chat`

可选模型：

- `deepseek-chat`
- `deepseek-reasoner`

### 3. OpenAI Compatible API

- `translationProvider` -> `openai`
- `translationBaseURL` -> `https://api.openai.com/v1`
- `translationModel` -> `gpt-4.1-mini`

可选模型：

- `gpt-4.1-mini`
- `gpt-4.1`
- `gpt-4o-mini`

### 4. 自定义 OpenAI Compatible 服务

- `translationProvider` -> `custom`
- `translationBaseURL` -> `https://<your-host>/v1`
- `translationModel` -> `<your-model-name>`

## 开发

```bash
npm install
npm start
```

生产构建：

```bash
npm run build
```

打包产物：

- `.scaffold/build/zotero-miner-u-translator.xpi`

## GitHub 仓库初始化

当前仓库默认远程已切换到 `Futuresxy/Zotero-MinerU-Translator`。

如果你以后要切到别的 GitHub 仓库，执行：

```bash
git remote set-url origin https://github.com/<your-user>/<your-repo>.git
```

如果你想要干净历史，建议新建 GitHub 空仓库后重新初始化：

```bash
rm -rf .git
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<your-user>/<your-repo>.git
```

## 注意事项

- 不建议把 MinerU Token 或 LLM API Key 提交到仓库。
- 当前笔记内容以 `<pre>` 保存译文 Markdown，优先保证可编辑和结构保真，不是富文本渲染器。
- 当前实现已通过 `npm run build` 打包验证。
