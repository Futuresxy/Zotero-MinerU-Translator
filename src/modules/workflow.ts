import { config } from "../../package.json";
import { translateMarkdownChunks } from "../services/llm";
import { convertPdfsToMarkdown } from "../services/mineru";
import {
  createTranslationNotes,
  updateTranslationNote,
} from "../services/note";
import { getSelectedPdfTargets } from "../services/selection";
import { getWorkflowSettings } from "../services/settings";
import { getString } from "../utils/locale";
import {
  prepareMarkdownForTranslation,
  restorePreservedMarkdown,
} from "../utils/markdown";

let running = false;

export async function translateSelectedPdfs() {
  const win = Zotero.getMainWindow();

  if (running) {
    return;
  }

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

  running = true;
  const progressWindow = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  });
  const lineStatus = 0;
  const lineFile = 1;
  const lineChunk = 2;
  const lineNote = 3;

  progressWindow
    .createLine({
      text: getString("menu-progress-start"),
      progress: 0,
      type: "default",
    })
    .createLine({
      text: `0/${targets.length}`,
      progress: 0,
      type: "default",
    })
    .createLine({
      text: `${getString("menu-progress-translate")} 0/0`,
      progress: 0,
      type: "default",
    })
    .createLine({
      text: `${getString("menu-progress-note")} 0/${targets.length}`,
      progress: 0,
      type: "default",
    })
    .show();

  try {
    progressWindow.changeLine({
      idx: lineStatus,
      text: `${getString("menu-progress-mineru")} 0/${targets.length}`,
      progress: 10,
      type: "default",
    });

    const markdownMap = await convertPdfsToMarkdown(targets, settings.mineru);
    const preparedTargets = targets.map((target) => {
      const originalMarkdown = markdownMap.get(target.dataID);
      if (!originalMarkdown) {
        throw new Error(`MinerU markdown missing for ${target.fileName}`);
      }

      return {
        target,
        originalMarkdown,
        prepared: prepareMarkdownForTranslation(
          originalMarkdown,
          settings.translation,
        ),
      };
    });
    const totalChunks = preparedTargets.reduce(
      (sum, item) => sum + item.prepared.chunks.length,
      0,
    );
    let completedChunks = 0;
    const results: string[] = [];

    progressWindow.changeLine({
      idx: lineStatus,
      text: `${getString("menu-progress-mineru")} ${targets.length}/${targets.length}`,
      progress: 25,
      type: "success",
    });

    for (let index = 0; index < preparedTargets.length; index++) {
      const { target, originalMarkdown, prepared } = preparedTargets[index];
      const fileLabel = `[${index + 1}/${preparedTargets.length}] ${target.displayTitle}`;
      const noteBundle = await createTranslationNotes({
        target,
        originalMarkdown,
        includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
        heading: settings.translation.noteHeading,
        providerLabel: settings.translation.provider,
        targetLanguage: settings.translation.targetLanguage,
        totalChunks: prepared.chunks.length,
      });
      const translatedChunks = new Array<string>(prepared.chunks.length).fill("");
      let noteSaveQueue = Promise.resolve();

      progressWindow.changeLine({
        idx: lineFile,
        text: fileLabel,
        progress: Math.round(((index + 1) / preparedTargets.length) * 100),
        type: "default",
      });
      progressWindow.changeLine({
        idx: lineChunk,
        text: `${getString("menu-progress-translate")} 0/${prepared.chunks.length} | ${completedChunks}/${totalChunks}`,
        progress:
          totalChunks > 0
            ? Math.round((completedChunks / totalChunks) * 100)
            : 100,
        type: "default",
      });

      try {
        await updateTranslationNote(noteBundle.translationNote, {
          target,
          translatedMarkdown: "",
          cleanedMarkdown: "",
          originalMarkdown,
          includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
          heading: settings.translation.noteHeading,
          providerLabel: settings.translation.provider,
          targetLanguage: settings.translation.targetLanguage,
          completedChunks: 0,
          totalChunks: prepared.chunks.length,
          status: prepared.chunks.length ? "translating" : "completed",
        });

        const translatedMarkdown = prepared.chunks.length
          ? restorePreservedMarkdown(
              await translateMarkdownChunks(prepared.chunks, settings.translation, {
                onProgress: ({ completed, total }) => {
                  const overallCompleted = completedChunks + completed;
                  progressWindow.changeLine({
                    idx: lineChunk,
                    text: `${getString("menu-progress-translate")} ${completed}/${total} | ${overallCompleted}/${totalChunks}`,
                    progress:
                      totalChunks > 0
                        ? Math.round((overallCompleted / totalChunks) * 100)
                        : 100,
                    type: "default",
                  });
                },
                onChunkTranslated: ({ latestCompletedIndex, text, completed, total }) => {
                  translatedChunks[latestCompletedIndex] = text;
                  noteSaveQueue = noteSaveQueue
                    .catch(() => undefined)
                    .then(async () => {
                      await updateTranslationNote(noteBundle.translationNote, {
                        target,
                        translatedMarkdown: translatedChunks
                          .filter(Boolean)
                          .join("\n\n"),
                        cleanedMarkdown: "",
                        originalMarkdown,
                        includeOriginalMarkdown:
                          settings.translation.includeOriginalMarkdown,
                        heading: settings.translation.noteHeading,
                        providerLabel: settings.translation.provider,
                        targetLanguage: settings.translation.targetLanguage,
                        completedChunks: completed,
                        totalChunks: total,
                        status: "translating",
                      });
                    });
                },
              }),
              prepared.preservedBlocks,
            )
          : prepared.cleanedMarkdown;
        completedChunks += prepared.chunks.length;
        await noteSaveQueue;

        progressWindow.changeLine({
          idx: lineNote,
          text: `${getString("menu-progress-note")} ${index + 1}/${preparedTargets.length}`,
          progress: Math.round(((index + 1) / preparedTargets.length) * 100),
          type: "default",
        });

        await updateTranslationNote(noteBundle.translationNote, {
          target,
          translatedMarkdown,
          cleanedMarkdown: prepared.cleanedMarkdown,
          originalMarkdown,
          includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
          heading: settings.translation.noteHeading,
          providerLabel: settings.translation.provider,
          targetLanguage: settings.translation.targetLanguage,
          completedChunks: prepared.chunks.length,
          totalChunks: prepared.chunks.length,
          status: "completed",
        });

        results.push(
          `${target.displayTitle} -> notes ${noteBundle.translationNote.id ?? "saved"}/${noteBundle.originalNote.id ?? "saved"}`,
        );
      } catch (error) {
        await noteSaveQueue.catch(() => undefined);
        const completedChunkCount = translatedChunks.filter(Boolean).length;
        const partialMarkdown = translatedChunks.filter(Boolean).join("\n\n");
        completedChunks += completedChunkCount;
        await updateTranslationNote(noteBundle.translationNote, {
          target,
          translatedMarkdown: partialMarkdown,
          cleanedMarkdown: partialMarkdown,
          originalMarkdown,
          includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
          heading: settings.translation.noteHeading,
          providerLabel: settings.translation.provider,
          targetLanguage: settings.translation.targetLanguage,
          completedChunks: completedChunkCount,
          totalChunks: prepared.chunks.length,
          status: partialMarkdown ? "partial" : "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        results.push(
          `${target.displayTitle} -> partial notes ${noteBundle.translationNote.id ?? "saved"}/${noteBundle.originalNote.id ?? "saved"}`,
        );
        continue;
      }
    }

    progressWindow.createLine({
      text: getString("menu-progress-done"),
      progress: 100,
      type: "success",
    });

    Zotero.alert(
      win,
      getString("menu-summary-title"),
      `${results.length}/${targets.length}\n${results.join("\n")}`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    progressWindow.createLine({
      text: message,
      progress: 100,
      type: "error",
    });
    Zotero.alert(win, config.addonName, message);
  } finally {
    running = false;
    progressWindow.startCloseTimer(8000);
  }
}
