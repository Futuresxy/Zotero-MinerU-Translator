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
  const xhr = await request(url, {
    method: "PUT",
    body: data,
    timeoutMs,
  });

  ensureSuccess(xhr, getResponseText(xhr), "Upload failed");
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
  if (typeof xhr.responseText === "string" && xhr.responseText) {
    return xhr.responseText;
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
