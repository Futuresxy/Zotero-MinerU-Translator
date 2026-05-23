import { config } from "../../package.json";
import { translateMarkdownChunks } from "../services/llm";
import { convertPdfsToMarkdown } from "../services/mineru";
import {
  createOrReuseTranslationNote,
  updateTranslationNote,
} from "../services/note";
import type { PdfTarget } from "../services/selection";
import { getSelectedPdfTargets } from "../services/selection";
import { getWorkflowSettings } from "../services/settings";
import { getString } from "../utils/locale";
import type { PreparedMarkdown } from "../utils/markdown";
import { prepareMarkdownForTranslation } from "../utils/markdown";
import { isWindowAlive } from "../utils/window";

type QueueStatus =
  | "queued"
  | "extracting"
  | "ready"
  | "translating"
  | "writing"
  | "completed"
  | "failed"
  | "canceled";

interface TranslationQueueItem {
  id: string;
  target: PdfTarget;
  status: QueueStatus;
  detail: string;
  completedChunks: number;
  totalChunks: number;
  originalMarkdown?: string;
  prepared?: PreparedMarkdown;
  translationNote?: Zotero.Item;
  noteID?: number;
  errorMessage?: string;
  addedAt: number;
  updatedAt: number;
}

type NoteUpdateParams = Parameters<typeof updateTranslationNote>[1];

const QUEUE_WINDOW_ROOT_ID = "mineruds-queue-root";

const queueItems: TranslationQueueItem[] = [];
let workerPromise: Promise<void> | null = null;
let running = false;
let shutdownRequested = false;
let activeRunToken = 0;
let queueNotice = "";
let schedulerWakeResolve: (() => void) | null = null;

export async function translateSelectedPdfs() {
  const win = Zotero.getMainWindow();
  const settings = getWorkflowSettings();

  if (!settings.enabled) {
    Zotero.alert(win, config.addonName, getString("menu-error-disabled"));
    return;
  }

  const targets = await getSelectedPdfTargets();
  if (!targets.length) {
    Zotero.alert(win, config.addonName, getString("menu-error-no-pdf"));
    return;
  }

  shutdownRequested = false;
  const added = enqueueTargets(targets);
  showTranslationQueueWindow();

  if (added > 0) {
    setQueueNotice(
      formatQueueNotice("added", {
        count: added,
      }),
    );
  } else {
    setQueueNotice(formatQueueNotice("duplicate"));
  }

  ensureQueueWorker();
}

export function showTranslationQueueWindow() {
  const win = Zotero.getMainWindow();
  const existingDialog = addon.data.dialog;

  if (existingDialog && isWindowAlive(existingDialog.window)) {
    existingDialog.window.focus();
    renderQueueWindow();
    return;
  }

  const dialog = new ztoolkit.Dialog(1, 1);
  dialog.addCell(0, 0, {
    tag: "div",
    namespace: "html",
    id: QUEUE_WINDOW_ROOT_ID,
    styles: {
      width: "100%",
      height: "100%",
    },
  });
  dialog.setDialogData({
    loadCallback: () => {
      setupQueueWindow(dialog.window);
      renderQueueWindow();
    },
    unloadCallback: () => {
      if (addon.data.dialog === dialog) {
        addon.data.dialog = undefined;
      }
    },
  });
  dialog.open(config.addonName, {
    width: 560,
    height: 760,
    centerscreen: true,
    resizable: true,
    fitContent: false,
    noDialogMode: true,
    alwaysRaised: true,
  });

  addon.data.dialog = dialog;
  win.focus();
  dialog.window.focus();
}

export function cancelTranslationWorkflow() {
  shutdownRequested = true;
  activeRunToken += 1;
  running = false;
  workerPromise = null;
  wakeQueueScheduler();

  for (const item of queueItems) {
    if (isTerminalStatus(item.status)) {
      continue;
    }
    item.status = "canceled";
    item.detail = text("queue-status-canceled");
    item.updatedAt = Date.now();
  }

  closeQueueWindow();
}

function ensureQueueWorker() {
  if (workerPromise) {
    return;
  }

  const runToken = ++activeRunToken;
  workerPromise = runQueueScheduler(runToken).finally(() => {
    if (runToken === activeRunToken) {
      running = false;
      workerPromise = null;
      renderQueueWindow();
    }
  });
}

async function runQueueScheduler(runToken: number) {
  running = true;
  const activeExtractions = new Set<Promise<void>>();
  const activeTranslations = new Set<Promise<void>>();

  while (true) {
    ensureRunIsActive(runToken);
    const settings = getWorkflowSettings();

    while (activeExtractions.size < settings.queue.extractConcurrency) {
      const item = queueItems.find((queueItem) => queueItem.status === "queued");
      if (!item) {
        break;
      }
      item.status = "extracting";
      item.detail = text("queue-stage-extracting");
      item.completedChunks = 0;
      item.totalChunks = 0;
      item.updatedAt = Date.now();
      const task = runExtractionTask(item, runToken)
        .catch((error) => {
          if (shutdownRequested || runToken !== activeRunToken) {
            return;
          }
          setQueueItemState(item, {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          activeExtractions.delete(task);
          renderQueueWindow();
        });
      activeExtractions.add(task);
    }

    while (activeTranslations.size < settings.queue.translateConcurrency) {
      const item = queueItems.find((queueItem) => queueItem.status === "ready");
      if (!item) {
        break;
      }
      item.status = "translating";
      item.detail = formatQueueNotice("translating", {
        count: item.totalChunks,
        completed: item.completedChunks,
      });
      item.updatedAt = Date.now();
      const task = runTranslationTask(item, runToken)
        .catch((error) => {
          if (shutdownRequested || runToken !== activeRunToken) {
            return;
          }
          setQueueItemState(item, {
            status: "failed",
            detail: error instanceof Error ? error.message : String(error),
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          activeTranslations.delete(task);
          renderQueueWindow();
        });
      activeTranslations.add(task);
    }

    renderQueueWindow();

    const hasPendingItems = queueItems.some(
      (item) => !isTerminalStatus(item.status),
    );
    if (!hasPendingItems && activeExtractions.size === 0 && activeTranslations.size === 0) {
      setQueueNotice(formatQueueNotice("idle"));
      return;
    }

    const waits = [
      ...activeExtractions,
      ...activeTranslations,
    ];
    if (!waits.length) {
      await delay(250);
      continue;
    }
    await Promise.race([ ...waits, waitForQueueWake() ]);
  }
}

async function runExtractionTask(item: TranslationQueueItem, runToken: number) {
  const settings = getWorkflowSettings();
  if (!settings.enabled) {
    throw new Error(getString("menu-error-disabled"));
  }

  ensureRunIsActive(runToken);

  const markdownMap = await convertPdfsToMarkdown([item.target], settings.mineru);
  ensureRunIsActive(runToken);

  const originalMarkdown = markdownMap.get(item.target.dataID);
  if (!originalMarkdown) {
    throw new Error(`MinerU markdown missing for ${item.target.fileName}`);
  }

  const prepared = prepareMarkdownForTranslation(
    originalMarkdown,
    settings.translation,
  );
  setQueueItemState(item, {
    detail: text("queue-stage-preparing"),
    totalChunks: prepared.chunks.length,
  });

  const translationNote = await createOrReuseTranslationNote({
    target: item.target,
    originalMarkdown,
    includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
    heading: settings.translation.noteHeading,
    providerLabel: settings.translation.provider,
    modelLabel: settings.translation.model,
    targetLanguage: settings.translation.targetLanguage,
    filterStats: prepared.stats,
    totalChunks: prepared.chunks.length,
  });
  await updateTranslationNote(translationNote, {
    target: item.target,
    translatedMarkdown: "",
    originalMarkdown,
    includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
    heading: settings.translation.noteHeading,
    providerLabel: settings.translation.provider,
    modelLabel: settings.translation.model,
    targetLanguage: settings.translation.targetLanguage,
    filterStats: prepared.stats,
    completedChunks: 0,
    totalChunks: prepared.chunks.length,
    status: "pending",
  });

  item.originalMarkdown = originalMarkdown;
  item.prepared = prepared;
  item.translationNote = translationNote;
  item.noteID = translationNote.id;
  setQueueItemState(item, {
    status: "ready",
    detail: formatQueueNotice("ready", {
      count: prepared.chunks.length,
    }),
    completedChunks: 0,
    totalChunks: prepared.chunks.length,
  });
}

async function runTranslationTask(item: TranslationQueueItem, runToken: number) {
  const settings = getWorkflowSettings();
  if (!settings.enabled) {
    throw new Error(getString("menu-error-disabled"));
  }
  if (!item.originalMarkdown || !item.prepared || !item.translationNote) {
    throw new Error("Prepared translation data is missing.");
  }

  const originalMarkdown = item.originalMarkdown;
  const prepared = item.prepared;
  const translationNote = item.translationNote;
  const translatedChunks = new Array<string>(prepared.chunks.length).fill("");
  let noteSaveQueue = Promise.resolve();
  let noteRevision = 0;

  const scheduleNoteUpdate = (params: NoteUpdateParams) => {
    const revision = ++noteRevision;
    noteSaveQueue = noteSaveQueue
      .catch(() => undefined)
      .then(async () => {
        if (
          revision !== noteRevision ||
          shutdownRequested ||
          runToken !== activeRunToken
        ) {
          return;
        }
        await updateTranslationNote(translationNote, params);
      });
    return noteSaveQueue;
  };

  await scheduleNoteUpdate({
    target: item.target,
    translatedMarkdown: "",
    originalMarkdown,
    includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
    heading: settings.translation.noteHeading,
    providerLabel: settings.translation.provider,
    modelLabel: settings.translation.model,
    targetLanguage: settings.translation.targetLanguage,
    filterStats: prepared.stats,
    completedChunks: 0,
    totalChunks: prepared.chunks.length,
    status: prepared.chunks.length ? "translating" : "completed",
  });

  const translatedMarkdown = prepared.chunks.length
    ? await translateMarkdownChunks(prepared.chunks, settings.translation, {
        onProgress: ({ completed, total }) => {
          if (shutdownRequested || runToken !== activeRunToken) {
            return;
          }
          setQueueItemState(item, {
            status: "translating",
            completedChunks: completed,
            totalChunks: total,
            detail: formatQueueNotice("translating", {
              count: total,
              completed,
            }),
          });
        },
        onChunkTranslated: ({ latestCompletedIndex, text, completed, total }) => {
          if (shutdownRequested || runToken !== activeRunToken) {
            return;
          }
          translatedChunks[latestCompletedIndex] = text;
          void scheduleNoteUpdate({
            target: item.target,
            translatedMarkdown: translatedChunks.filter(Boolean).join("\n\n"),
            originalMarkdown,
            includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
            heading: settings.translation.noteHeading,
            providerLabel: settings.translation.provider,
            modelLabel: settings.translation.model,
            targetLanguage: settings.translation.targetLanguage,
            filterStats: prepared.stats,
            completedChunks: completed,
            totalChunks: total,
            status: "translating",
          });
        },
      })
    : prepared.cleanedMarkdown;

  ensureRunIsActive(runToken);
  setQueueItemState(item, {
    status: "writing",
    detail: text("queue-stage-writing"),
  });

  await scheduleNoteUpdate({
    target: item.target,
    translatedMarkdown,
    originalMarkdown,
    includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
    heading: settings.translation.noteHeading,
    providerLabel: settings.translation.provider,
    modelLabel: settings.translation.model,
    targetLanguage: settings.translation.targetLanguage,
    filterStats: prepared.stats,
    completedChunks: prepared.chunks.length,
    totalChunks: prepared.chunks.length,
    status: "completed",
  });
  await noteSaveQueue;

  setQueueItemState(item, {
    status: "completed",
    detail: text("queue-status-completed"),
    completedChunks: prepared.chunks.length,
    totalChunks: prepared.chunks.length,
  });
  item.prepared = undefined;
  item.originalMarkdown = undefined;
  item.translationNote = undefined;
  setQueueNotice(formatQueueNotice("completed", { name: item.target.displayTitle }));
}

function enqueueTargets(targets: PdfTarget[]) {
  let added = 0;

  for (const target of targets) {
    if (hasActiveQueueItem(target.attachment.id)) {
      continue;
    }

    queueItems.push({
      id: `${target.attachment.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      target,
      status: "queued",
      detail: text("queue-status-queued"),
      completedChunks: 0,
      totalChunks: 0,
      addedAt: Date.now(),
      updatedAt: Date.now(),
    });
    added += 1;
  }

  wakeQueueScheduler();
  renderQueueWindow();
  return added;
}

function hasActiveQueueItem(attachmentID: number) {
  return queueItems.some(
    (item) =>
      item.target.attachment.id === attachmentID && !isTerminalStatus(item.status),
  );
}

function setQueueItemState(
  item: TranslationQueueItem,
  patch: Partial<TranslationQueueItem>,
) {
  Object.assign(item, patch, {
    updatedAt: Date.now(),
  });
  renderQueueWindow();
}

function renderQueueWindow() {
  const dialog = addon.data.dialog;
  if (!dialog || !isWindowAlive(dialog.window)) {
    return;
  }

  const doc = dialog.window.document;
  const root = doc.getElementById(QUEUE_WINDOW_ROOT_ID);
  if (!root) {
    return;
  }

  const total = queueItems.length;
  const queued = queueItems.filter((item) => item.status === "queued").length;
  const active = queueItems.filter((item) =>
    ["extracting", "ready", "translating", "writing"].includes(item.status),
  ).length;
  const completed = queueItems.filter((item) => item.status === "completed").length;
  const failed = queueItems.filter((item) => item.status === "failed").length;
  const current = getCurrentQueueItem();
  const settings = getWorkflowSettings();

  root.innerHTML = `
    <style>
      .mineruds-shell {
        min-height: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: 14px;
        padding: 18px;
        box-sizing: border-box;
        overflow: auto;
        color: #1d2b2a;
        background:
          radial-gradient(circle at top right, rgba(29, 112, 100, 0.18), transparent 32%),
          linear-gradient(180deg, #fbf7ef, #f1eadf);
        font-family: "Palatino Linotype", "Source Han Serif SC", Georgia, serif;
      }
      .mineruds-hero {
        display: grid;
        gap: 10px;
        padding: 18px 18px 16px;
        border-radius: 20px;
        color: #f7f4ee;
        background: linear-gradient(135deg, #173f3b, #2f7b70);
        box-shadow: 0 16px 34px rgba(22, 60, 57, 0.2);
      }
      .mineruds-hero h1 {
        margin: 0;
        font-size: 26px;
        letter-spacing: 0.02em;
      }
      .mineruds-hero p {
        margin: 0;
        font-size: 13px;
        line-height: 1.6;
        color: rgba(247, 244, 238, 0.92);
      }
      .mineruds-actions,
      .mineruds-stats,
      .mineruds-active,
      .mineruds-list {
        border-radius: 18px;
        background: rgba(255, 255, 255, 0.84);
        border: 1px solid rgba(24, 63, 59, 0.08);
        box-shadow: 0 10px 24px rgba(55, 64, 69, 0.08);
      }
      .mineruds-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        padding: 14px;
      }
      .mineruds-config {
        margin-top: 4px;
        padding: 10px 12px;
        border-radius: 12px;
        background: rgba(255, 255, 255, 0.12);
        color: rgba(247, 244, 238, 0.92);
        font-size: 12px;
        line-height: 1.6;
      }
      .mineruds-actions button {
        border: none;
        border-radius: 999px;
        padding: 10px 14px;
        font-size: 12px;
        cursor: pointer;
        background: #1e6158;
        color: #fff;
      }
      .mineruds-actions button.secondary {
        background: #e8ddd0;
        color: #264441;
      }
      .mineruds-actions button.ghost {
        background: #f7f1e8;
        color: #365452;
      }
      .mineruds-notice {
        margin: 0 14px 14px;
        padding: 10px 12px;
        border-radius: 12px;
        background: #f5eee2;
        color: #4f5e5d;
        font-size: 12px;
      }
      .mineruds-stats {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 10px;
        padding: 14px;
      }
      .mineruds-stat {
        padding: 12px;
        border-radius: 14px;
        background: linear-gradient(180deg, #fffdf9, #f5ede1);
      }
      .mineruds-stat strong {
        display: block;
        font-size: 24px;
        color: #184b46;
      }
      .mineruds-stat span {
        font-size: 11px;
        color: #61706e;
      }
      .mineruds-active {
        padding: 16px;
      }
      .mineruds-active h2,
      .mineruds-list h2 {
        margin: 0 0 10px;
        font-size: 17px;
        color: #183f3b;
      }
      .mineruds-active-card {
        padding: 14px;
        border-radius: 14px;
        background: linear-gradient(180deg, #fffaf3, #f4ebde);
      }
      .mineruds-active-card strong {
        display: block;
        margin-bottom: 6px;
        font-size: 14px;
      }
      .mineruds-subtle {
        font-size: 12px;
        color: #60716e;
      }
      .mineruds-list {
        padding: 16px;
        overflow: hidden;
        flex: 1 1 auto;
        min-height: 260px;
      }
      .mineruds-list-body {
        display: grid;
        gap: 10px;
        max-height: 100%;
        overflow: auto;
        padding-right: 4px;
      }
      .mineruds-item {
        display: grid;
        gap: 8px;
        padding: 14px;
        border-radius: 14px;
        background: #fffdfa;
        border: 1px solid rgba(24, 63, 59, 0.08);
      }
      .mineruds-item-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      .mineruds-item-title {
        font-size: 14px;
        font-weight: 700;
        color: #1f3836;
      }
      .mineruds-badge {
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 11px;
        white-space: nowrap;
      }
      .mineruds-badge-queued { background: #efe6da; color: #6b5b4e; }
      .mineruds-badge-extracting { background: #dceee8; color: #24584f; }
      .mineruds-badge-ready { background: #e7efe6; color: #35584d; }
      .mineruds-badge-translating { background: #d7ebf6; color: #234e6f; }
      .mineruds-badge-writing { background: #ece3f7; color: #5b3f7d; }
      .mineruds-badge-completed { background: #ddeedc; color: #2f6640; }
      .mineruds-badge-failed { background: #f4dddd; color: #7a3535; }
      .mineruds-badge-canceled { background: #ece8e2; color: #6b6358; }
      .mineruds-progress {
        height: 8px;
        border-radius: 999px;
        background: #ece4d9;
        overflow: hidden;
      }
      .mineruds-progress > span {
        display: block;
        height: 100%;
        background: linear-gradient(90deg, #1c6158, #4aa08f);
      }
      .mineruds-item-actions {
        display: flex;
        gap: 8px;
      }
      .mineruds-item-actions button {
        border: none;
        background: #f1eadf;
        color: #284642;
        border-radius: 999px;
        padding: 6px 10px;
        font-size: 11px;
        cursor: pointer;
      }
      .mineruds-empty {
        padding: 24px 16px;
        border-radius: 14px;
        background: #fffaf3;
        color: #677774;
        font-size: 13px;
        line-height: 1.7;
      }
    </style>
    <div class="mineruds-shell">
      <section class="mineruds-hero">
        <h1>MineruDS Translator Queue</h1>
        <p>在 Zotero 主列表里选中一个或多个 PDF，然后点击“加入当前选中 PDF”。任务会自动进入流水线：当前论文翻译时，后续论文可以继续进行 MinerU 解析；这个面板可以随时关闭和重新打开。</p>
        <div class="mineruds-config">
          当前并发配置：MinerU 文档并发 <strong>${settings.queue.extractConcurrency}</strong>，论文翻译并发 <strong>${settings.queue.translateConcurrency}</strong>，单篇分段并发 <strong>${settings.translation.concurrency}</strong>
        </div>
      </section>
      <section class="mineruds-actions">
        <button id="mineruds-add-selection">加入当前选中 PDF</button>
        <button id="mineruds-clear-finished" class="secondary">清除已完成/失败项</button>
        <button id="mineruds-close-panel" class="ghost">关闭面板</button>
      </section>
      <section class="mineruds-stats">
        ${renderStatCard(String(total), "总任务")}
        ${renderStatCard(String(queued), "排队中")}
        ${renderStatCard(String(active), "进行中")}
        ${renderStatCard(`${completed}/${failed}`, "完成/失败")}
      </section>
      <section class="mineruds-active">
        <h2>当前任务</h2>
        ${
          current
            ? `<div class="mineruds-active-card">
                <strong>${escapeHtml(current.target.displayTitle)}</strong>
                <div class="mineruds-subtle">${escapeHtml(current.target.fileName)}</div>
                <div class="mineruds-subtle" style="margin-top:8px;">${escapeHtml(current.detail)}</div>
              </div>`
            : `<div class="mineruds-active-card">
                <div class="mineruds-subtle">当前没有正在运行的任务。你可以直接在 Zotero 里多选 PDF 后加入队列。</div>
              </div>`
        }
        ${queueNotice ? `<div class="mineruds-notice">${escapeHtml(queueNotice)}</div>` : ""}
      </section>
      <section class="mineruds-list">
        <h2>翻译列表</h2>
        <div class="mineruds-list-body">
          ${
            queueItems.length
              ? queueItems
                  .map((item) => renderQueueItemHtml(item))
                  .join("")
              : `<div class="mineruds-empty">还没有任务。<br/>你可以在 Zotero 主列表中多选 PDF，然后点击上面的按钮，或者使用右键菜单把 PDF 加入队列。</div>`
          }
        </div>
      </section>
    </div>
  `;

  bindQueueWindowActions(doc);
}

function setupQueueWindow(win: Window) {
  const documentElement = win.document.documentElement as HTMLElement | null;
  const body = win.document.body as HTMLBodyElement | null;
  if (documentElement) {
    documentElement.style.height = "100%";
  }
  if (body) {
    body.style.height = "100%";
    body.style.margin = "0";
    body.style.background = "#f1eadf";
  }
  win.focus();
}

function bindQueueWindowActions(doc: Document) {
  doc
    .getElementById("mineruds-add-selection")
    ?.addEventListener("click", () => void addCurrentSelectionFromWindow());
  doc
    .getElementById("mineruds-clear-finished")
    ?.addEventListener("click", clearFinishedQueueItems);
  doc
    .getElementById("mineruds-close-panel")
    ?.addEventListener("click", closeQueueWindow);

  const noteButtons = Array.from(
    doc.querySelectorAll("[data-note-id]"),
  ) as HTMLButtonElement[];
  noteButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const noteID = Number(button.dataset.noteId);
        if (Number.isFinite(noteID) && noteID > 0) {
          Zotero.getMainWindow().ZoteroPane.selectItem(noteID);
        }
      });
    });
}

async function addCurrentSelectionFromWindow() {
  const targets = await getSelectedPdfTargets();
  if (!targets.length) {
    setQueueNotice("当前没有选中可加入队列的 PDF。");
    renderQueueWindow();
    return;
  }

  const added = enqueueTargets(targets);
  setQueueNotice(
    added
      ? formatQueueNotice("added", { count: added })
      : formatQueueNotice("duplicate"),
  );
  showTranslationQueueWindow();
  ensureQueueWorker();
}

function clearFinishedQueueItems() {
  const before = queueItems.length;
  for (let index = queueItems.length - 1; index >= 0; index--) {
    if (isTerminalStatus(queueItems[index].status)) {
      queueItems.splice(index, 1);
    }
  }

  const removed = before - queueItems.length;
  setQueueNotice(
    removed ? `已从列表中清除 ${removed} 条已结束任务。` : "当前没有可清除的已结束任务。",
  );
  renderQueueWindow();
}

function closeQueueWindow() {
  const dialog = addon.data.dialog;
  if (!dialog?.window) {
    return;
  }

  try {
    dialog.window.close();
  } catch {
    // Ignore close failures.
  }
}

function ensureRunIsActive(runToken: number) {
  if (shutdownRequested || runToken !== activeRunToken) {
    throw new Error("Translation canceled because Zotero is closing.");
  }
}

function isTerminalStatus(status: QueueStatus) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function setQueueNotice(message: string) {
  queueNotice = message;
  renderQueueWindow();
}

function renderQueueItemHtml(item: TranslationQueueItem) {
  const progress =
    item.totalChunks > 0
      ? Math.round((item.completedChunks / item.totalChunks) * 100)
      : item.status === "completed"
        ? 100
        : 0;

  return `
    <article class="mineruds-item">
      <div class="mineruds-item-top">
        <div>
          <div class="mineruds-item-title">${escapeHtml(item.target.displayTitle)}</div>
          <div class="mineruds-subtle">${escapeHtml(item.target.fileName)}</div>
        </div>
        <span class="mineruds-badge mineruds-badge-${item.status}">
          ${escapeHtml(describeStatus(item.status))}
        </span>
      </div>
      <div class="mineruds-subtle">${escapeHtml(item.detail)}</div>
      <div class="mineruds-progress"><span style="width:${progress}%"></span></div>
      <div class="mineruds-subtle">
        ${
          item.totalChunks > 0
            ? `分段 ${item.completedChunks}/${item.totalChunks}`
            : "尚未进入分段翻译"
        }
      </div>
      ${
        item.noteID
          ? `<div class="mineruds-item-actions">
              <button data-note-id="${item.noteID}">定位到翻译笔记</button>
            </div>`
          : ""
      }
    </article>
  `;
}

function renderStatCard(value: string, label: string) {
  return `<div class="mineruds-stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
}

function getCurrentQueueItem() {
  const priority: QueueStatus[] = [
    "writing",
    "translating",
    "extracting",
    "ready",
    "queued",
    "failed",
    "canceled",
    "completed",
  ];

  for (const status of priority) {
    const item = queueItems.find((queueItem) => queueItem.status === status);
    if (item && !isTerminalStatus(item.status)) {
      return item;
    }
  }

  return undefined;
}

function describeStatus(status: QueueStatus) {
  if (status === "queued") return "排队中";
  if (status === "extracting") return "MinerU 解析";
  if (status === "ready") return "等待翻译";
  if (status === "translating") return "翻译中";
  if (status === "writing") return "写入笔记";
  if (status === "completed") return "已完成";
  if (status === "failed") return "失败";
  return "已取消";
}

function formatQueueNotice(
  type: "added" | "duplicate" | "completed" | "idle" | "translating" | "ready",
  payload: Partial<{
    count: number;
    completed: number;
    name: string;
  }> = {},
) {
  if (type === "added") {
    return `已加入 ${payload.count || 0} 个 PDF 到翻译队列。`;
  }
  if (type === "duplicate") {
    return "当前选中的 PDF 已经在队列里，未重复添加。";
  }
  if (type === "completed") {
    return `翻译完成：${payload.name || "任务"}。`;
  }
  if (type === "idle") {
    return "队列已经处理完毕，可以继续添加新的 PDF。";
  }
  if (type === "ready") {
    return `MinerU 已完成，等待翻译。共 ${payload.count || 0} 个分段。`;
  }
  return `正在翻译分段 ${payload.completed || 0}/${payload.count || 0}。`;
}

function text(
  key:
    | "queue-status-queued"
    | "queue-stage-extracting"
    | "queue-stage-preparing"
    | "queue-stage-writing"
    | "queue-status-completed"
    | "queue-status-canceled",
) {
  if (key === "queue-status-queued") return "等待开始";
  if (key === "queue-stage-extracting") return "正在调用 MinerU 解析 PDF";
  if (key === "queue-stage-preparing") return "正在清洗正文并准备分段";
  if (key === "queue-stage-writing") return "正在写入 Zotero 笔记";
  if (key === "queue-status-completed") return "翻译和写入已完成";
  return "任务已取消";
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function waitForQueueWake() {
  return new Promise<void>((resolve) => {
    schedulerWakeResolve = resolve;
  });
}

function wakeQueueScheduler() {
  schedulerWakeResolve?.();
  schedulerWakeResolve = null;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
