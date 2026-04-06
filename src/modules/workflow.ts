import { config } from "../../package.json";
import { translateMarkdownChunks } from "../services/llm";
import { convertPdfsToMarkdown } from "../services/mineru";
import { saveTranslationNote } from "../services/note";
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
    closeOnClick: true,
    closeTime: -1,
  });

  progressWindow
    .createLine({
      text: getString("menu-progress-start"),
      progress: 0,
      type: "default",
    })
    .show();

  try {
    progressWindow.createLine({
      text: `${getString("menu-progress-mineru")} (${targets.length})`,
      progress: 20,
      type: "default",
    });

    const markdownMap = await convertPdfsToMarkdown(targets, settings.mineru);
    const results: string[] = [];

    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const originalMarkdown = markdownMap.get(target.dataID);
      if (!originalMarkdown) {
        throw new Error(`MinerU markdown missing for ${target.fileName}`);
      }

      const prepared = prepareMarkdownForTranslation(
        originalMarkdown,
        settings.translation,
      );

      progressWindow.createLine({
        text: `[${index + 1}/${targets.length}] ${target.displayTitle}: ${getString("menu-progress-translate")} (${prepared.chunks.length})`,
        progress: 55,
        type: "default",
      });

      const translatedMarkdown = prepared.chunks.length
        ? await translateMarkdownChunks(prepared.chunks, settings.translation)
        : "";

      progressWindow.createLine({
        text: `[${index + 1}/${targets.length}] ${target.displayTitle}: ${getString("menu-progress-note")}`,
        progress: 85,
        type: "default",
      });

      const noteItem = await saveTranslationNote({
        target,
        translatedMarkdown,
        cleanedMarkdown: prepared.cleanedMarkdown,
        originalMarkdown,
        includeOriginalMarkdown: settings.translation.includeOriginalMarkdown,
        heading: settings.translation.noteHeading,
        providerLabel: settings.translation.provider,
        targetLanguage: settings.translation.targetLanguage,
      });

      results.push(`${target.displayTitle} -> note ${noteItem.id ?? "saved"}`);
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
