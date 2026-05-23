import { initLocale } from "./utils/locale";
import { registerContextMenu } from "./modules/contextMenu";
import { registerPreferencePane } from "./modules/preferences";
import { registerPrefsScripts } from "./modules/preferenceScript";
import {
  cancelTranslationWorkflow,
  showTranslationQueueWindow,
} from "./modules/workflow";
import { createZToolkit } from "./utils/ztoolkit";

let uiRegistered = false;

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  initLocale();
  registerPreferencePane();

  await Promise.all(Zotero.getMainWindows().map((win) => onMainWindowLoad(win)));

  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  registerToolbarButton(win);

  if (!uiRegistered) {
    registerContextMenu();
    uiRegistered = true;
  }
}

async function onMainWindowUnload(win: Window): Promise<void> {
  void win;
  cancelTranslationWorkflow();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  cancelTranslationWorkflow();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  void event;
  void type;
  void ids;
  void extraData;
}

async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  if (type === "load") {
    await registerPrefsScripts(data.window);
  }
}

function onShortcuts(type: string) {
  void type;
}

function onDialogEvents(type: string) {
  void type;
}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};

function registerToolbarButton(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  const buttonID = `${addon.data.config.addonRef}-toolbar-button`;
  if (doc.getElementById(buttonID)) {
    return;
  }

  const toolbar =
    doc.getElementById("zotero-toolbar") ||
    doc.querySelector("toolbar");
  if (!toolbar) {
    return;
  }

  const button = ztoolkit.UI.createElement(doc, "toolbarbutton", {
    id: buttonID,
    namespace: "xul",
    attributes: {
      class: "toolbarbutton-1",
      tooltiptext: getToolbarTooltip(),
      removable: "false",
    },
    styles: {
      listStyleImage: `url(chrome://${addon.data.config.addonRef}/content/icons/favicon.png)`,
      padding: "4px",
      marginInline: "4px",
    },
    listeners: [
      {
        type: "command",
        listener: () => {
          showTranslationQueueWindow();
        },
      },
    ],
  });

  const syncButton = doc.getElementById("zotero-tb-sync");
  if (syncButton?.parentNode) {
    syncButton.parentNode.insertBefore(button, syncButton);
    return;
  }

  toolbar.appendChild(button);
}

function getToolbarTooltip() {
  return /^zh/i.test(Zotero.locale || "")
    ? "打开 MineruDS 翻译队列面板"
    : "Open MineruDS translation queue";
}
