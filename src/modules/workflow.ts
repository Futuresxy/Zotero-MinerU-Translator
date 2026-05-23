import { config } from "../../package.json";
import { translateMarkdownChunks } from "../services/llm";
import { convertPdfsToMarkdown } from "../services/mineru";
import {
  createOrReuseTranslationNote,
  updateTranslationNote,
} from "../services/note";
import { getSelectedPdfTargets } from "../services/selection";
import { getWorkflowSettings } from "../services/settings";
import { getString } from "../utils/locale";
import { prepareMarkdownForTranslation } from "../utils/markdown";

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
    window: win,
    closeOnClick: true,
    closeTime: -1,
    closeOtherProgressWindows: false,
  });
  const lineStatus = 0;
  const lineFile = 1;
  const lineChunk = 2;
  const lineNote = 3;
  const lineHint = 4;

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
    .createLine({
      text: getString("menu-progress-closable"),
      progress: 100,
      type: "default",
    })
    .show(-1);

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
      const translationNote = await createOrReuseTranslationNote({
        target,
        originalMarkdown,
        includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
        heading: settings.translation.noteHeading,
        providerLabel: settings.translation.provider,
        modelLabel: settings.translation.model,
        targetLanguage: settings.translation.targetLanguage,
        filterStats: prepared.stats,
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
        await updateTranslationNote(translationNote, {
          target,
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
                    await updateTranslationNote(translationNote, {
                      target,
                      translatedMarkdown: translatedChunks
                        .filter(Boolean)
                        .join("\n\n"),
                      originalMarkdown,
                      includeOriginalMarkdown:
                        settings.translation.includeOriginalMarkdown,
                      heading: settings.translation.noteHeading,
                      providerLabel: settings.translation.provider,
                      modelLabel: settings.translation.model,
                      targetLanguage: settings.translation.targetLanguage,
                      filterStats: prepared.stats,
                      completedChunks: completed,
                      totalChunks: total,
                      status: "translating",
                    });
                  });
              },
            })
          : prepared.cleanedMarkdown;
        completedChunks += prepared.chunks.length;
        await noteSaveQueue;

        progressWindow.changeLine({
          idx: lineNote,
          text: `${getString("menu-progress-note")} ${index + 1}/${preparedTargets.length}`,
          progress: Math.round(((index + 1) / preparedTargets.length) * 100),
          type: "default",
        });

        await updateTranslationNote(translationNote, {
          target,
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

        results.push(
          `${target.displayTitle} -> note ${translationNote.id ?? "saved"}`,
        );
      } catch (error) {
        await noteSaveQueue.catch(() => undefined);
        const completedChunkCount = translatedChunks.filter(Boolean).length;
        const partialMarkdown = translatedChunks.filter(Boolean).join("\n\n");
        completedChunks += completedChunkCount;
        await updateTranslationNote(translationNote, {
          target,
          translatedMarkdown: partialMarkdown,
          originalMarkdown,
          includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
          heading: settings.translation.noteHeading,
          providerLabel: settings.translation.provider,
          modelLabel: settings.translation.model,
          targetLanguage: settings.translation.targetLanguage,
          filterStats: prepared.stats,
          completedChunks: completedChunkCount,
          totalChunks: prepared.chunks.length,
          status: partialMarkdown ? "partial" : "failed",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        results.push(
          `${target.displayTitle} -> partial note ${translationNote.id ?? "saved"}`,
        );
        continue;
      }
    }

    progressWindow.createLine({
      text: getString("menu-progress-done"),
      progress: 100,
      type: "success",
    });
    progressWindow.changeLine({
      idx: lineHint,
      text: getString("menu-progress-close-manually"),
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
    progressWindow.changeLine({
      idx: lineHint,
      text: getString("menu-progress-close-manually"),
      progress: 100,
      type: "error",
    });
    Zotero.alert(win, config.addonName, message);
  } finally {
    running = false;
  }
}
