import { strFromU8, unzipSync } from "fflate";
import { fetchBinary, fetchJSON, putBinary } from "./http";
import type { PdfTarget } from "./selection";
import type { MinerUSettings } from "./settings";

interface MinerUBatchCreateResponse {
  code: number;
  msg: string;
  data?: {
    batch_id?: string;
    file_urls?: string[];
  };
}

interface MinerUBatchResultResponse {
  code: number;
  msg: string;
  data?: {
    batch_id?: string;
    extract_result?: Array<{
      file_name?: string;
      state?: string;
      full_zip_url?: string;
      err_msg?: string;
      data_id?: string;
    }>;
  };
}

export async function convertPdfsToMarkdown(
  targets: PdfTarget[],
  settings: MinerUSettings,
) {
  if (!settings.apiToken) {
    throw new Error("Missing MinerU API token.");
  }
  if (!targets.length) {
    return new Map<string, string>();
  }

  const createResponse = await fetchJSON<MinerUBatchCreateResponse>(
    `${settings.baseURL}/file-urls/batch`,
    {
      method: "POST",
      timeoutMs: 60000,
      headers: createAuthorizedJSONHeaders(settings.apiToken),
      body: JSON.stringify({
        files: targets.map((target) => ({
          name: target.fileName,
          data_id: target.dataID,
          ...(settings.pageRanges ? { page_ranges: settings.pageRanges } : {}),
        })),
        model_version: settings.modelVersion,
        language: settings.language,
        enable_table: settings.enableTable,
        enable_formula: settings.enableFormula,
        is_ocr: settings.enableOCR,
      }),
    },
  );

  if (
    createResponse.code !== 0 ||
    !createResponse.data?.batch_id ||
    !createResponse.data.file_urls ||
    createResponse.data.file_urls.length !== targets.length
  ) {
    throw new Error(`MinerU batch creation failed: ${createResponse.msg}`);
  }

  for (let index = 0; index < targets.length; index++) {
    const binary = await readFileBytes(targets[index].filePath);
    const uploadURL = createResponse.data.file_urls[index];
    try {
      await putBinary(uploadURL, binary);
    } catch (error) {
      const host = getHostLabel(uploadURL);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `MinerU upload failed for ${targets[index].fileName} (${host}): ${detail}`,
      );
    }
  }

  const batchID = createResponse.data.batch_id;
  const deadline = Date.now() + settings.timeoutMs;
  const markdownMap = new Map<string, string>();

  while (Date.now() < deadline) {
    const result = await fetchJSON<MinerUBatchResultResponse>(
      `${settings.baseURL.replace(/\/file-urls$/, "")}/extract-results/batch/${batchID}`,
      {
        timeoutMs: 60000,
        headers: createAuthorizedHeaders(settings.apiToken),
      },
    );

    if (result.code !== 0) {
      throw new Error(`MinerU polling failed: ${result.msg}`);
    }

    const extractResults = result.data?.extract_result || [];
    let hasFailure = false;

    for (const item of extractResults) {
      const dataID = item.data_id || findDataIDByFileName(item.file_name, targets);
      if (!dataID || markdownMap.has(dataID)) {
        continue;
      }

      if (item.state === "failed") {
        hasFailure = true;
        throw new Error(
          `MinerU failed for ${item.file_name || dataID}: ${item.err_msg || "unknown error"}`,
        );
      }

      if (item.state === "done" && item.full_zip_url) {
        markdownMap.set(dataID, await downloadFullMarkdown(item.full_zip_url));
      }
    }

    if (markdownMap.size === targets.length) {
      return markdownMap;
    }

    if (!hasFailure) {
      await Zotero.Promise.delay(settings.pollIntervalMs);
    }
  }

  throw new Error("MinerU batch polling timed out.");
}

function createAuthorizedJSONHeaders(token: string) {
  return {
    ...createAuthorizedHeaders(token),
    "Content-Type": "application/json",
  };
}

function createAuthorizedHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "*/*",
  };
}

function findDataIDByFileName(fileName: string | undefined, targets: PdfTarget[]) {
  return targets.find((target) => target.fileName === fileName)?.dataID;
}

async function downloadFullMarkdown(zipURL: string) {
  const archive = await fetchBinary(zipURL, { timeoutMs: 120000 });
  const files = unzipSync(archive);
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith("/full.md") || path === "full.md") {
      return strFromU8(content);
    }
  }
  throw new Error("MinerU result zip does not contain full.md.");
}

async function readFileBytes(filePath: string): Promise<Uint8Array> {
  const ioUtils = (globalThis as any).IOUtils;
  if (!ioUtils?.read) {
    throw new Error("IOUtils.read is not available in this Zotero runtime.");
  }
  return (await ioUtils.read(filePath)) as Uint8Array;
}

function getHostLabel(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown host";
  }
}
