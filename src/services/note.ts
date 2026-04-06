import type { PdfTarget } from "./selection";

interface SaveTranslationNoteParams {
  target: PdfTarget;
  translatedMarkdown: string;
  cleanedMarkdown: string;
  originalMarkdown: string;
  includeOriginalMarkdown: boolean;
  heading: string;
  providerLabel: string;
  targetLanguage: string;
}

export async function saveTranslationNote(params: SaveTranslationNoteParams) {
  const noteItem = new Zotero.Item("note");
  noteItem.libraryID = params.target.libraryID;
  if (params.target.noteParentID) {
    noteItem.parentID = params.target.noteParentID;
  }

  noteItem.setNote(renderNoteHtml(params));
  await noteItem.saveTx();
  return noteItem;
}

function renderNoteHtml(params: SaveTranslationNoteParams) {
  const metadataRows = [
    ["Source PDF", params.target.fileName],
    ["Parent Item", params.target.displayTitle],
    ["Provider", params.providerLabel],
    ["Target Language", params.targetLanguage],
    ["Generated At", new Date().toLocaleString()],
  ]
    .map(
      ([label, value]) =>
        `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`,
    )
    .join("");

  const sections = [
    `<h1>${escapeHtml(`${params.heading}｜${params.target.displayTitle}`)}</h1>`,
    metadataRows,
    "<h2>Translated Markdown</h2>",
    `<pre>${escapeHtml(params.translatedMarkdown || params.cleanedMarkdown)}</pre>`,
  ];

  if (params.includeOriginalMarkdown) {
    sections.push("<h2>Original Markdown</h2>");
    sections.push(`<pre>${escapeHtml(params.originalMarkdown)}</pre>`);
  }

  return sections.join("\n");
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
