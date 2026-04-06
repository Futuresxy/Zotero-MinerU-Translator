import { getString } from "../utils/locale";
import { translateSelectedPdfs } from "./workflow";

export function registerContextMenu() {
  const menuIcon = `chrome://${addon.data.config.addonRef}/content/icons/favicon@0.5x.png`;

  ztoolkit.Menu.register("item", {
    tag: "menuitem",
    id: "zotero-itemmenu-zoterominerutranslator-translate",
    label: getString("menuitem-label"),
    commandListener: () => {
      void translateSelectedPdfs();
    },
    icon: menuIcon,
  });
}
