import type { PdfTarget } from "./selection";
import type { MarkdownFilterStats } from "../utils/markdown";

interface TranslationNoteBaseParams {
  target: PdfTarget;
  originalMarkdown: string;
  includeOriginalMarkdown: boolean;
  heading: string;
  providerLabel: string;
  modelLabel: string;
  targetLanguage: string;
  filterStats: MarkdownFilterStats;
}

interface CreateTranslationNoteParams extends TranslationNoteBaseParams {
  totalChunks: number;
}

interface UpdateTranslationNoteParams extends TranslationNoteBaseParams {
  translatedMarkdown: string;
  completedChunks: number;
  totalChunks: number;
  status: "pending" | "translating" | "partial" | "completed" | "failed";
  errorMessage?: string;
}

export async function createOrReuseTranslationNote(
  params: CreateTranslationNoteParams,
) {
  const translationNote = (await findExistingTranslationNote(params.target)) ||
    createChildNote(params.target);
  translationNote.setNote(
    renderTranslationNoteHtml({
      ...params,
      translatedMarkdown: "",
      completedChunks: 0,
      totalChunks: params.totalChunks,
      status: "pending",
    }),
  );
  await translationNote.saveTx();
  return translationNote;
}

export async function updateTranslationNote(
  noteItem: Zotero.Item,
  params: UpdateTranslationNoteParams,
) {
  noteItem.setNote(renderTranslationNoteHtml(params));
  await noteItem.saveTx();
}

async function findExistingTranslationNote(target: PdfTarget) {
  const noteIDs = target.parentItem?.getNotes?.() || [];
  const marker = getAttachmentMarker(target);

  for (const noteID of noteIDs) {
    const item = (await Zotero.Items.getAsync(noteID)) as Zotero.Item;
    if (item.getNote().includes(marker)) {
      return item;
    }
  }

  return null;
}

function renderTranslationNoteHtml(params: UpdateTranslationNoteParams) {
  const metadataRows = [
    ["来源 PDF", params.target.fileName],
    ["所属条目", params.target.displayTitle],
    ["翻译提供方", params.providerLabel],
    ["模型", params.modelLabel],
    ["目标语言", params.targetLanguage],
    ["状态", renderStatusLabel(params.status)],
    ["分段进度", `${params.completedChunks}/${params.totalChunks}`],
    ["跳过图片", String(params.filterStats.imagesRemoved)],
    ["跳过表格", String(params.filterStats.tablesRemoved)],
    ["跳过算法/伪代码", String(params.filterStats.algorithmsRemoved)],
    ["跳过 details/包装块", String(params.filterStats.detailsRemoved)],
    [
      "跳过参考文献",
      params.filterStats.referencesRemoved ? "是" : "否",
    ],
    [
      "跳过前置信息区块",
      String(params.filterStats.frontMatterBlocksRemoved),
    ],
    ["生成时间", new Date().toLocaleString()],
  ]
    .map(
      ([label, value]) =>
        `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`,
    )
    .join("");

  const sections = [
    `<!-- ${escapeHtml(getAttachmentMarker(params.target))} -->`,
    `<h1>${escapeHtml(`${params.heading}｜${params.target.displayTitle}`)}</h1>`,
    metadataRows,
  ];

  if (params.errorMessage) {
    sections.push(
      `<p><strong>错误信息:</strong> ${escapeHtml(params.errorMessage)}</p>`,
    );
  }

  sections.push("<h2>译文</h2>");
  if (params.translatedMarkdown.trim()) {
    sections.push(renderMarkdownAsHtml(params.translatedMarkdown));
  } else if (params.status === "completed") {
    sections.push("<p><em>过滤后没有可翻译的正文内容。</em></p>");
  } else {
    sections.push("<p><em>正在准备翻译内容……</em></p>");
  }

  if (params.includeOriginalMarkdown) {
    sections.push("<h2>MinerU 原始 Markdown</h2>");
    sections.push(`<pre>${escapeHtml(params.originalMarkdown)}</pre>`);
  }

  return sections.join("\n");
}

function createChildNote(target: PdfTarget) {
  const noteItem = new Zotero.Item("note");
  noteItem.libraryID = target.libraryID;
  if (target.noteParentID) {
    noteItem.parentID = target.noteParentID;
  }
  return noteItem;
}

function getAttachmentMarker(target: PdfTarget) {
  return `ZPT_TRANSLATION_NOTE attachment-id=${target.attachment.id}`;
}

function renderStatusLabel(status: UpdateTranslationNoteParams["status"]) {
  if (status === "pending") return "待处理";
  if (status === "translating") return "翻译中";
  if (status === "partial") return "部分完成";
  if (status === "completed") return "已完成";
  return "失败";
}

function renderMarkdownAsHtml(markdown: string) {
  const blocks = markdown
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);

  return blocks.map((block) => renderMarkdownBlock(block)).join("\n");
}

function renderMarkdownBlock(block: string) {
  const lines = block.split("\n");
  const firstLine = lines[0].trim();
  const headingMatch = firstLine.match(/^(#{1,6})\s+(.+)$/);

  if (headingMatch) {
    const level = Math.min(6, headingMatch[1].length);
    return `<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`;
  }

  if (firstLine.startsWith("```") || firstLine.startsWith("~~~")) {
    const code = lines.slice(1, -1).join("\n");
    return `<pre><code>${escapeHtml(code)}</code></pre>`;
  }

  if (lines.every((line) => /^\s*[-*+]\s+/.test(line))) {
    const items = lines
      .map((line) => line.replace(/^\s*[-*+]\s+/, ""))
      .map((line) => `<li>${renderInlineMarkdown(line)}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  if (lines.every((line) => /^\s*\d+\.\s+/.test(line))) {
    const items = lines
      .map((line) => line.replace(/^\s*\d+\.\s+/, ""))
      .map((line) => `<li>${renderInlineMarkdown(line)}</li>`)
      .join("");
    return `<ol>${items}</ol>`;
  }

  if (lines.every((line) => /^\s*>\s?/.test(line))) {
    const text = lines
      .map((line) => line.replace(/^\s*>\s?/, ""))
      .map((line) => renderInlineMarkdown(line))
      .join("<br/>");
    return `<blockquote>${text}</blockquote>`;
  }

  if (/^---+$/.test(firstLine) || /^\*\*\*+$/.test(firstLine)) {
    return "<hr />";
  }

  return `<p>${lines.map((line) => renderInlineMarkdown(line)).join("<br/>")}</p>`;
}

function renderInlineMarkdown(value: string) {
  const placeholders: string[] = [];
  let escaped = escapeHtml(value);

  escaped = escaped.replace(
    /`([^`]+)`/g,
    (_, text: string) => storePlaceholder(placeholders, `<code>${text}</code>`),
  );
  escaped = escaped.replace(
    /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g,
    (_, text: string, url: string) =>
      storePlaceholder(
        placeholders,
        `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`,
      ),
  );
  escaped = escaped.replace(
    /\*\*([^*]+)\*\*/g,
    (_, text: string) => storePlaceholder(placeholders, `<strong>${text}</strong>`),
  );
  escaped = escaped.replace(
    /__([^_]+)__/g,
    (_, text: string) => storePlaceholder(placeholders, `<strong>${text}</strong>`),
  );
  escaped = escaped.replace(
    /(^|[\s(])\*([^*]+)\*(?=[\s).,;:!?]|$)/g,
    (_, prefix: string, text: string) =>
      `${prefix}${storePlaceholder(placeholders, `<em>${text}</em>`)}`,
  );
  escaped = escaped.replace(
    /(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g,
    (_, prefix: string, text: string) =>
      `${prefix}${storePlaceholder(placeholders, `<em>${text}</em>`)}`,
  );

  return restorePlaceholders(escaped, placeholders);
}

function storePlaceholder(placeholders: string[], html: string) {
  const token = `[[[ZPT_HTML_${placeholders.length}]]]`;
  placeholders.push(html);
  return token;
}

function restorePlaceholders(value: string, placeholders: string[]) {
  return value.replace(/\[\[\[ZPT_HTML_(\d+)\]\]\]/g, (_, index: string) => {
    return placeholders[Number(index)] || "";
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
