interface FetchOptions extends RequestInit {
  timeoutMs?: number;
  headers?: HeadersInit;
}

export async function fetchJSON<T>(
  url: string,
  options: FetchOptions = {},
): Promise<T> {
  const response = await fetchWithTimeout(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return JSON.parse(text) as T;
}

export async function fetchText(
  url: string,
  options: FetchOptions = {},
): Promise<string> {
  const response = await fetchWithTimeout(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return text;
}

export async function fetchBinary(
  url: string,
  options: FetchOptions = {},
): Promise<Uint8Array> {
  const response = await fetchWithTimeout(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function putBinary(
  url: string,
  data: Uint8Array,
  timeoutMs = 120000,
) {
  const response = await fetchWithTimeout(url, {
    method: "PUT",
    body: data,
    timeoutMs,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Upload failed (${response.status}): ${body.slice(0, 240)}`);
  }
}

async function fetchWithTimeout(
  url: string,
  options: FetchOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 60000;
  const abortController = createAbortController();
  const fetchPromise = fetch(url, {
    ...options,
    ...(abortController ? { signal: abortController.signal } : {}),
  });

  if (!timeoutMs || timeoutMs <= 0) {
    return fetchPromise;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      fetchPromise,
      new Promise<Response>((_, reject) => {
        timer = setTimeout(() => {
          abortController?.abort();
          reject(new Error(`Request timed out after ${timeoutMs}ms: ${url}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function createAbortController(): AbortController | undefined {
  const AbortControllerCtor = globalThis.AbortController;
  if (!AbortControllerCtor) {
    return undefined;
  }
  return new AbortControllerCtor();
}
