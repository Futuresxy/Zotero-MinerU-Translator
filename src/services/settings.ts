import { getPref } from "../utils/prefs";

export type TranslationProvider = "openai" | "deepseek" | "doubao" | "custom";
export type MinerUModelVersion = "pipeline" | "vlm" | "MinerU-HTML";

export interface MinerUSettings {
  baseURL: string;
  apiToken: string;
  modelVersion: MinerUModelVersion;
  language: string;
  enableTable: boolean;
  enableFormula: boolean;
  enableOCR: boolean;
  pageRanges?: string;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface TranslationSettings {
  provider: TranslationProvider;
  baseURL: string;
  apiKey: string;
  model: string;
  targetLanguage: string;
  systemPrompt: string;
  temperature: number;
  chunkChars: number;
  skipImages: boolean;
  skipTables: boolean;
  skipReferences: boolean;
  noteHeading: string;
  includeOriginalMarkdown: boolean;
}

export interface WorkflowSettings {
  enabled: boolean;
  mineru: MinerUSettings;
  translation: TranslationSettings;
}

const PROVIDER_BASE_URLS: Record<TranslationProvider, string> = {
  openai: "https://api.openai.com/v1",
  deepseek: "https://api.deepseek.com/v1",
  doubao: "https://ark.cn-beijing.volces.com/api/v3",
  custom: "",
};

export function getWorkflowSettings(): WorkflowSettings {
  const provider = normalizeProvider(getPref("translationProvider"));
  const customBaseURL = getPref("translationBaseURL").trim();

  return {
    enabled: getPref("translationEnabled"),
    mineru: {
      baseURL: getPref("mineruBaseURL").trim().replace(/\/+$/, ""),
      apiToken: getPref("mineruApiToken").trim(),
      modelVersion: normalizeMinerUModel(getPref("mineruModelVersion")),
      language: getPref("mineruLanguage").trim() || "en",
      enableTable: getPref("mineruEnableTable"),
      enableFormula: getPref("mineruEnableFormula"),
      enableOCR: getPref("mineruEnableOCR"),
      pageRanges: getPref("mineruPageRanges").trim() || undefined,
      pollIntervalMs: Math.max(
        1000,
        Number(getPref("mineruPollIntervalMs")) || 3000,
      ),
      timeoutMs: Math.max(30, Number(getPref("mineruTimeoutSec")) || 300) * 1000,
    },
    translation: {
      provider,
      baseURL: (customBaseURL || PROVIDER_BASE_URLS[provider]).replace(
        /\/+$/,
        "",
      ),
      apiKey: getPref("translationApiKey").trim(),
      model: getPref("translationModel").trim(),
      targetLanguage: getPref("translationTargetLanguage").trim() || "简体中文",
      systemPrompt: getPref("translationSystemPrompt").trim(),
      temperature: clampTemperature(getPref("translationTemperature")),
      chunkChars: Math.max(
        800,
        Number(getPref("translationChunkChars")) || 2800,
      ),
      skipImages: getPref("skipImages"),
      skipTables: getPref("skipTables"),
      skipReferences: getPref("skipReferences"),
      noteHeading: getPref("noteHeading").trim() || "PDF 翻译",
      includeOriginalMarkdown: getPref("includeOriginalMarkdown"),
    },
  };
}

function normalizeProvider(value: string): TranslationProvider {
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai") return "openai";
  if (normalized === "deepseek") return "deepseek";
  if (normalized === "doubao") return "doubao";
  return "custom";
}

function normalizeMinerUModel(value: string): MinerUModelVersion {
  if (value === "pipeline" || value === "MinerU-HTML") {
    return value;
  }
  return "vlm";
}

function clampTemperature(value: string) {
  const numeric = Number(value);
  if (Number.isNaN(numeric)) {
    return 0.1;
  }
  return Math.max(0, Math.min(2, numeric));
}
