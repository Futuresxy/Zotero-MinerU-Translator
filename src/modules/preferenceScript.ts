import type { TranslationProvider } from "../services/settings";
import { getProviderBaseURL } from "../services/settings";
import { getPref, setPref } from "../utils/prefs";

interface SavedTranslationProfile {
  name: string;
  provider: TranslationProvider;
  baseURL: string;
  apiKey: string;
  model: string;
}

const PROVIDER_OPTIONS: Array<{
  value: TranslationProvider;
  label: string;
}> = [
  { value: "openai", label: "OpenAI" },
  { value: "deepseek", label: "DeepSeek" },
  { value: "doubao", label: "Doubao" },
  { value: "glm", label: "GLM" },
  { value: "gemini", label: "Gemini" },
  { value: "custom", label: "Custom" },
];

export async function registerPrefsScripts(window: Window) {
  const document = window.document;
  const providerSelect = getElement<HTMLSelectElement>(
    document,
    "translationProvider",
  );
  const baseURLInput = getElement<HTMLInputElement>(document, "translationBaseURL");
  const apiKeyInput = getElement<HTMLInputElement>(document, "translationApiKey");
  const modelInput = getElement<HTMLInputElement>(document, "translationModel");
  const profileNameInput = getElement<HTMLInputElement>(
    document,
    "translationProfileName",
  );
  const savedProfilesSelect = getElement<HTMLSelectElement>(
    document,
    "translationSavedProfiles",
  );
  const saveButton = getElement<HTMLButtonElement>(
    document,
    "translationProfileSave",
  );
  const loadButton = getElement<HTMLButtonElement>(
    document,
    "translationProfileLoad",
  );
  const deleteButton = getElement<HTMLButtonElement>(
    document,
    "translationProfileDelete",
  );

  populateProviderOptions(providerSelect, document);
  providerSelect.value = normalizeProviderValue(getPref("translationProvider"));
  if (!baseURLInput.value.trim()) {
    const defaultBaseURL = getProviderBaseURL(
      normalizeProviderValue(providerSelect.value),
    );
    baseURLInput.value = defaultBaseURL;
    setPref("translationBaseURL", defaultBaseURL);
  }

  providerSelect.addEventListener("change", () => {
    const provider = normalizeProviderValue(providerSelect.value);
    const previousBaseURL = baseURLInput.value.trim();
    const previousProvider = normalizeProviderValue(getPref("translationProvider"));
    setPref("translationProvider", provider);

    const previousDefault = getProviderBaseURL(previousProvider);
    const nextDefault = getProviderBaseURL(provider);
    if (!previousBaseURL || previousBaseURL === previousDefault || provider !== "custom") {
      baseURLInput.value = nextDefault;
      setPref("translationBaseURL", nextDefault);
    }
  });

  baseURLInput.addEventListener("change", () => {
    setPref("translationBaseURL", baseURLInput.value.trim());
  });
  apiKeyInput.addEventListener("change", () => {
    setPref("translationApiKey", apiKeyInput.value.trim());
  });
  modelInput.addEventListener("change", () => {
    setPref("translationModel", modelInput.value.trim());
  });
  profileNameInput.addEventListener("change", () => {
    setPref("translationProfileName", profileNameInput.value.trim());
  });

  const refreshSavedProfiles = () => {
    const profiles = readSavedProfiles();
    savedProfilesSelect.replaceChildren();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = profiles.length ? "Select profile" : "No saved profiles";
    savedProfilesSelect.appendChild(placeholder);

    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.name;
      option.textContent = `${profile.name} | ${profile.provider} | ${profile.model}`;
      savedProfilesSelect.appendChild(option);
    }
  };

  saveButton.addEventListener("command", () => {
    const provider = normalizeProviderValue(providerSelect.value);
    const name =
      profileNameInput.value.trim() ||
      `${provider}:${modelInput.value.trim() || "default"}`;
    const profiles = readSavedProfiles().filter((item) => item.name !== name);
    profiles.unshift({
      name,
      provider,
      baseURL: baseURLInput.value.trim() || getProviderBaseURL(provider),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim(),
    });
    writeSavedProfiles(profiles.slice(0, 20));
    profileNameInput.value = name;
    setPref("translationProfileName", name);
    refreshSavedProfiles();
    savedProfilesSelect.value = name;
  });

  loadButton.addEventListener("command", () => {
    const profiles = readSavedProfiles();
    const selected = profiles.find((item) => item.name === savedProfilesSelect.value);
    if (!selected) {
      return;
    }

    providerSelect.value = selected.provider;
    baseURLInput.value = selected.baseURL;
    apiKeyInput.value = selected.apiKey;
    modelInput.value = selected.model;
    profileNameInput.value = selected.name;

    setPref("translationProvider", selected.provider);
    setPref("translationBaseURL", selected.baseURL);
    setPref("translationApiKey", selected.apiKey);
    setPref("translationModel", selected.model);
    setPref("translationProfileName", selected.name);
  });

  deleteButton.addEventListener("command", () => {
    const selectedName = savedProfilesSelect.value;
    if (!selectedName) {
      return;
    }
    writeSavedProfiles(
      readSavedProfiles().filter((item) => item.name !== selectedName),
    );
    if (profileNameInput.value.trim() === selectedName) {
      profileNameInput.value = "";
      setPref("translationProfileName", "");
    }
    refreshSavedProfiles();
  });

  refreshSavedProfiles();

  addon.data.prefs = {
    window,
    columns: [],
    rows: [],
  };
}

function getElement<T extends Element>(document: Document, suffix: string) {
  return document.querySelector<T>(`#zotero-prefpane-${addon.data.config.addonRef}-${suffix}`)!;
}

function populateProviderOptions(
  select: HTMLSelectElement,
  document: Document,
) {
  if (select.options.length) {
    return;
  }

  for (const option of PROVIDER_OPTIONS) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }
}

function normalizeProviderValue(value: string): TranslationProvider {
  const matched = PROVIDER_OPTIONS.find((item) => item.value === value);
  return matched?.value || "custom";
}

function readSavedProfiles(): SavedTranslationProfile[] {
  try {
    const raw = getPref("translationProfiles");
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(isSavedProfile);
  } catch {
    return [];
  }
}

function writeSavedProfiles(profiles: SavedTranslationProfile[]) {
  setPref("translationProfiles", JSON.stringify(profiles));
}

function isSavedProfile(value: unknown): value is SavedTranslationProfile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const profile = value as Record<string, unknown>;
  return (
    typeof profile.name === "string" &&
    typeof profile.provider === "string" &&
    typeof profile.baseURL === "string" &&
    typeof profile.apiKey === "string" &&
    typeof profile.model === "string"
  );
}
