# MineruDS Translator

[![Zotero 7](https://img.shields.io/badge/Zotero-7-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org/)
[![Using Zotero Plugin Template](https://img.shields.io/badge/Using-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

Zotero 7 插件，用于把 Zotero 中的 PDF 论文送到 MinerU 批量解析接口，提取 Markdown，再调用 DeepSeek / OpenAI 兼容的大模型接口做分段详细翻译，并把结果持续写回同一个 Zotero 子笔记。

## 当前实现

1. 在 Zotero 条目右键菜单中增加 `翻译 PDF 并写入笔记`
2. 支持选中 PDF 附件，或选中包含 PDF 附件的父条目
3. 调用 MinerU `POST /api/v4/file-urls/batch` 申请上传链接
4. PUT 上传 PDF 文件，自动触发 MinerU 解析
5. 轮询 `GET /api/v4/extract-results/batch/{batch_id}`
6. 下载返回 zip，并提取 `full.md`
7. 过滤图片、表格、参考文献区块，避免进入最终译文
8. 按字符数切分 Markdown，并对超长分段失败场景自动二次拆分重试
9. 调用 OpenAI 兼容 `POST /chat/completions` 或 `POST /responses`
10. 将译文实时写回同一个 Zotero 子笔记，进度窗保持显示，直到手动关闭

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

- `Tools -> Plugins -> MineruDS Translator -> Preferences`

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
- `translationConcurrency`

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

批量翻译脚本：

```bash
MINERU_API_TOKEN="<your-mineru-token>" \
TRANSLATION_API_KEY="<your-key>" \
npm run batch:translate -- \
  --input example \
  --extractor mineru \
  --base-url https://ark.cn-beijing.volces.com/api/v3/responses \
  --model doubao-seed-1-8-251228 \
  --output-dir batch-output
```

说明：

- 提供 `MINERU_API_TOKEN` 时，脚本会优先走 MinerU，并在翻译前过滤图片、表格和参考文献
- 不提供 MinerU Token 时，会回退到本机 `pdftotext`，这时无法保留 MinerU 识别出的图片和表格 Markdown
- 默认只输出 `*.translated.md`

打包产物：

- `.scaffold/build/mineruds-translator.xpi`

## GitHub 仓库初始化

当前仓库保留现有 GitHub release 工作流配置，构建产物名称已调整为 `mineruds-translator.xpi`，方便直接沿用当前仓库发布 release。

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
- 当前版本默认只生成一个翻译子笔记；如启用 `includeOriginalMarkdown`，会把 MinerU 原始 Markdown 附在同一条笔记后部。
- 当前实现已通过 `npm run build` 打包验证。
