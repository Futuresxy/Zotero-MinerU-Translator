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

  ensureMinerUDirectConnection(settings.baseURL);

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
    ensureMinerUDirectConnection(uploadURL);
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
      const dataID =
        item.data_id || findDataIDByFileName(item.file_name, targets);
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
        ensureMinerUDirectConnection(item.full_zip_url);
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

function findDataIDByFileName(
  fileName: string | undefined,
  targets: PdfTarget[],
) {
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

const MINERU_DIRECT_DOMAINS = [
  "mineru.net",
  "openxlab.org.cn",
  "cdn-mineru.openxlab.org.cn",
];

const minerUDirectHosts = new Set(MINERU_DIRECT_DOMAINS);
let minerUProxyBypassRegistered = false;
let minerUProxyFilter: unknown = null;

function ensureMinerUDirectConnection(url: string) {
  addDirectHostFromURL(url);
  registerMinerUProxyBypass();
  appendMinerUNoProxyPreference();
}

function addDirectHostFromURL(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host) {
      minerUDirectHosts.add(host);
    }
  } catch {
    // Ignore non-URL values; known MinerU domains are still covered.
  }
}

function registerMinerUProxyBypass() {
  if (minerUProxyBypassRegistered) {
    return;
  }

  try {
    const components = (globalThis as any).Components;
    const proxyService = components.classes[
      "@mozilla.org/network/protocol-proxy-service;1"
    ].getService(components.interfaces.nsIProtocolProxyService);

    minerUProxyFilter = {
      applyFilter(
        _proxyService: unknown,
        uri: { asciiHost?: string; host?: string },
        proxyInfo: unknown,
      ) {
        const host = (uri.asciiHost || uri.host || "").toLowerCase();
        return isMinerUDirectHost(host) ? null : proxyInfo;
      },
    };

    proxyService.registerFilter(minerUProxyFilter, 0);
    minerUProxyBypassRegistered = true;
  } catch (error) {
    Zotero.debug(
      `MinerU proxy bypass filter unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function appendMinerUNoProxyPreference() {
  try {
    const services = (globalThis as any).Services;
    const prefs = services?.prefs;
    if (!prefs?.getCharPref || !prefs?.setCharPref) {
      return;
    }

    const prefName = "network.proxy.no_proxies_on";
    const current = prefs.getCharPref(prefName, "");
    const entries = current
      .split(",")
      .map((entry: string) => entry.trim())
      .filter(Boolean);
    const normalized = new Set(
      entries.map((entry: string) => entry.toLowerCase()),
    );
    let changed = false;

    for (const host of minerUDirectHosts) {
      if (!normalized.has(host)) {
        entries.push(host);
        normalized.add(host);
        changed = true;
      }
    }

    if (changed) {
      prefs.setCharPref(prefName, entries.join(", "));
    }
  } catch (error) {
    Zotero.debug(
      `MinerU proxy exclusion update failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isMinerUDirectHost(host: string) {
  if (!host) {
    return false;
  }

  for (const directHost of minerUDirectHosts) {
    if (host === directHost || host.endsWith(`.${directHost}`)) {
      return true;
    }
  }
  return false;
}
