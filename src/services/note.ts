import type { PdfTarget } from "./selection";

interface TranslationNoteBaseParams {
  target: PdfTarget;
  originalMarkdown: string;
  includeOriginalMarkdown: boolean;
  heading: string;
  providerLabel: string;
  targetLanguage: string;
}

interface CreateTranslationNotesParams extends TranslationNoteBaseParams {
  totalChunks: number;
}

interface UpdateTranslationNoteParams extends TranslationNoteBaseParams {
  translatedMarkdown: string;
  cleanedMarkdown: string;
  completedChunks: number;
  totalChunks: number;
  status: "pending" | "translating" | "partial" | "completed" | "failed";
  errorMessage?: string;
}

export interface TranslationNoteBundle {
  translationNote: Zotero.Item;
  originalNote: Zotero.Item;
}

export async function createTranslationNotes(
  params: CreateTranslationNotesParams,
): Promise<TranslationNoteBundle> {
  const translationNote = createChildNote(params.target);
  translationNote.setNote(
    renderTranslatedNoteHtml({
      ...params,
      translatedMarkdown: "",
      cleanedMarkdown: "",
      completedChunks: 0,
      totalChunks: params.totalChunks,
      status: "pending",
    }),
  );
  await translationNote.saveTx();

  const originalNote = createChildNote(params.target);
  originalNote.setNote(renderOriginalMarkdownNoteHtml(params));
  await originalNote.saveTx();

  return {
    translationNote,
    originalNote,
  };
}

export async function updateTranslationNote(
  noteItem: Zotero.Item,
  params: UpdateTranslationNoteParams,
) {
  noteItem.setNote(renderTranslatedNoteHtml(params));
  await noteItem.saveTx();
}

function renderTranslatedNoteHtml(params: UpdateTranslationNoteParams) {
  const metadataRows = [
    ["Source PDF", params.target.fileName],
    ["Parent Item", params.target.displayTitle],
    ["Provider", params.providerLabel],
    ["Target Language", params.targetLanguage],
    ["Status", renderStatusLabel(params.status)],
    ["Progress", `${params.completedChunks}/${params.totalChunks}`],
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
  ];

  if (params.errorMessage) {
    sections.push(`<p><strong>Error:</strong> ${escapeHtml(params.errorMessage)}</p>`);
  }

  sections.push("<h2>Translated Markdown</h2>");
  sections.push(
    `<pre>${escapeHtml(params.translatedMarkdown || params.cleanedMarkdown || "")}</pre>`,
  );

  if (params.includeOriginalMarkdown) {
    sections.push("<h2>Original Markdown</h2>");
    sections.push(`<pre>${escapeHtml(params.originalMarkdown)}</pre>`);
  }

  return sections.join("\n");
}

function renderOriginalMarkdownNoteHtml(params: TranslationNoteBaseParams) {
  const metadataRows = [
    ["Source PDF", params.target.fileName],
    ["Parent Item", params.target.displayTitle],
    ["Generated At", new Date().toLocaleString()],
  ]
    .map(
      ([label, value]) =>
        `<p><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</p>`,
    )
    .join("");

  return [
    `<h1>${escapeHtml(`MinerU Markdown｜${params.target.displayTitle}`)}</h1>`,
    metadataRows,
    "<h2>Original Markdown</h2>",
    `<pre>${escapeHtml(params.originalMarkdown)}</pre>`,
  ].join("\n");
}

function createChildNote(target: PdfTarget) {
  const noteItem = new Zotero.Item("note");
  noteItem.libraryID = target.libraryID;
  if (target.noteParentID) {
    noteItem.parentID = target.noteParentID;
  }
  return noteItem;
}

function renderStatusLabel(status: UpdateTranslationNoteParams["status"]) {
  if (status === "pending") return "Pending";
  if (status === "translating") return "Translating";
  if (status === "partial") return "Partial";
  if (status === "completed") return "Completed";
  return "Failed";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
