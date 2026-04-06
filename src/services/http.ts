interface HTTPOptions {
  method?: string;
  body?: string | Uint8Array;
  timeoutMs?: number;
  headers?: Record<string, string>;
  responseType?: XMLHttpRequestResponseType;
}

export async function fetchJSON<T>(
  url: string,
  options: HTTPOptions = {},
): Promise<T> {
  const xhr = await request(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const text = getResponseText(xhr);
  ensureSuccess(xhr, text);
  return JSON.parse(text) as T;
}

export async function fetchText(
  url: string,
  options: HTTPOptions = {},
): Promise<string> {
  const xhr = await request(url, options);
  const text = getResponseText(xhr);
  ensureSuccess(xhr, text);
  return text;
}

export async function fetchBinary(
  url: string,
  options: HTTPOptions = {},
): Promise<Uint8Array> {
  const xhr = await request(url, {
    ...options,
    responseType: "arraybuffer",
  });
  ensureSuccess(xhr, getResponseText(xhr));
  return new Uint8Array((xhr.response as ArrayBuffer) || new ArrayBuffer(0));
}

export async function putBinary(
  url: string,
  data: Uint8Array,
  timeoutMs = 120000,
) {
  let fetchError: unknown;

  try {
    await putBinaryWithFetch(url, data, timeoutMs);
    return;
  } catch (error) {
    fetchError = error;
  }

  try {
    const xhr = await request(url, {
      method: "PUT",
      body: data,
      timeoutMs,
    });

    ensureSuccess(xhr, getResponseText(xhr), "Upload failed");
  } catch (error) {
    const parts = [];
    if (fetchError) {
      parts.push(`fetch: ${stringifyNetworkError(fetchError)}`);
    }
    parts.push(`Zotero.HTTP: ${stringifyNetworkError(error)}`);
    throw new Error(parts.join("; "));
  }
}

async function request(
  url: string,
  options: HTTPOptions = {},
): Promise<XMLHttpRequest> {
  const method = options.method || "GET";

  try {
    return await Zotero.HTTP.request(method, url, {
      body: options.body,
      headers: options.headers,
      responseType: options.responseType,
      successCodes: false,
      timeout: options.timeoutMs ?? 60000,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown network error.";
    throw new Error(`Network request failed for ${url}: ${message}`);
  }
}

async function putBinaryWithFetch(
  url: string,
  body: Uint8Array,
  timeoutMs: number,
) {
  if (typeof fetch !== "function") {
    throw new Error("fetch is not available in this Zotero runtime.");
  }

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer =
    controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

  try {
    const response = await fetch(url, {
      method: "PUT",
      body,
      signal: controller?.signal,
    });
    const text = await response.text().catch(() => "");
    if (response.ok) {
      return;
    }
    throw new Error(`Upload failed (${response.status}): ${text.slice(0, 240)}`);
  } catch (error) {
    if ((error as { name?: string })?.name === "AbortError") {
      throw new Error(`Upload timed out after ${timeoutMs} ms.`);
    }
    throw error;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function ensureSuccess(
  xhr: XMLHttpRequest,
  text: string,
  prefix = "HTTP request failed",
) {
  if (xhr.status >= 200 && xhr.status < 300) {
    return;
  }

  if (xhr.status === 0) {
    let host = "";
    try {
      host = new URL(xhr.responseURL || "").host;
    } catch {
      host = "";
    }
    const locationHint = host ? ` from ${host}` : "";
    throw new Error(
      `${prefix} (0): no HTTP response${locationHint}. In Zotero this usually means the request was blocked, the TLS/proxy chain interfered, or the remote upload endpoint closed the connection before replying.`,
    );
  }

  throw new Error(`${prefix} (${xhr.status}): ${text.slice(0, 240)}`);
}

function getResponseText(xhr: XMLHttpRequest) {
  try {
    if (typeof xhr.responseText === "string" && xhr.responseText) {
      return xhr.responseText;
    }
  } catch {
    // responseText is inaccessible for non-text responseType values in Firefox.
  }

  if (typeof xhr.response === "string") {
    return xhr.response;
  }

  if (xhr.response instanceof ArrayBuffer) {
    try {
      return new TextDecoder().decode(new Uint8Array(xhr.response));
    } catch {
      return "";
    }
  }

  return "";
}

function stringifyNetworkError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
