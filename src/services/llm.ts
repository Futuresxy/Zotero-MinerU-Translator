import { fetchJSON } from "./http";
import type { TranslationSettings } from "./settings";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
}

interface ResponsesAPIResponse {
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
}

export interface TranslationProgress {
  completed: number;
  total: number;
  latestCompletedIndex: number;
}

export interface TranslationChunkResult extends TranslationProgress {
  text: string;
}

export interface TranslationCallbacks {
  onProgress?: (progress: TranslationProgress) => void;
  onChunkTranslated?: (result: TranslationChunkResult) => void;
}

const MAX_TRANSLATION_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1500;
const RETRYABLE_STATUS_CODES = [408, 409, 429, 500, 502, 503, 504];
const MAX_TRANSLATION_SPLIT_DEPTH = 2;

export async function translateMarkdownChunks(
  chunks: string[],
  settings: TranslationSettings,
  callbacks: TranslationCallbacks = {},
) {
  if (!settings.apiKey) {
    throw new Error("Missing translation API key.");
  }
  if (!settings.baseURL) {
    throw new Error("Missing translation base URL.");
  }
  if (!settings.model) {
    throw new Error("Missing translation model.");
  }

  const translated = await translateChunksWithConcurrency(
    chunks,
    settings,
    callbacks,
  );
  return translated.join("\n\n");
}

async function translateChunksWithConcurrency(
  chunks: string[],
  settings: TranslationSettings,
  callbacks: TranslationCallbacks,
) {
  const translated = new Array<string>(chunks.length);
  const concurrency = Math.min(
    Math.max(1, settings.concurrency || 1),
    chunks.length || 1,
  );
  let nextIndex = 0;
  let completed = 0;

  callbacks.onProgress?.({
    completed: 0,
    total: chunks.length,
    latestCompletedIndex: -1,
  });

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= chunks.length) {
          return;
        }

        translated[index] = await translateSingleChunk(
          chunks[index],
          index,
          chunks.length,
          settings,
        );
        completed += 1;
        callbacks.onProgress?.({
          completed,
          total: chunks.length,
          latestCompletedIndex: index,
        });
        callbacks.onChunkTranslated?.({
          completed,
          total: chunks.length,
          latestCompletedIndex: index,
          text: translated[index],
        });
      }
    }),
  );

  return translated;
}

async function translateSingleChunk(
  chunk: string,
  index: number,
  total: number,
  settings: TranslationSettings,
  splitDepth = 0,
) {
  const endpoint = resolveTranslationEndpoint(settings.baseURL);
  ensureTranslationDirectConnection(settings, endpoint.url);

  if (endpoint.apiStyle === "responses") {
    try {
      const response = await retryTranslationRequest(async () => {
        return await fetchJSON<ResponsesAPIResponse>(endpoint.url, {
          method: "POST",
          timeoutMs: 120000,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`,
          },
          body: JSON.stringify({
            model: settings.model,
            temperature: settings.temperature,
            input: createMessages(chunk, index, total, settings),
          }),
        });
      });

      if (response.error?.message) {
        throw new Error(`Translation API error: ${response.error.message}`);
      }

      const text = extractResponsesText(response);
      if (text) {
        const normalizedText = normalizeTranslatedMarkdown(text);
        ensureTranslationLooksApplied(
          chunk,
          normalizedText,
          settings.targetLanguage,
        );
        return normalizedText;
      }
      throw new Error("Translation API returned empty content.");
    } catch (error) {
      return await retryBySplittingChunk(
        error,
        chunk,
        index,
        total,
        settings,
        splitDepth,
      );
    }
  }

  try {
    const response = await retryTranslationRequest(async () => {
      return await fetchJSON<ChatCompletionResponse>(endpoint.url, {
        method: "POST",
        timeoutMs: 120000,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${settings.apiKey}`,
        },
        body: JSON.stringify({
          model: settings.model,
          temperature: settings.temperature,
          messages: createMessages(chunk, index, total, settings),
        }),
      });
    });

    if (response.error?.message) {
      throw new Error(`Translation API error: ${response.error.message}`);
    }

    const content = response.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      const normalizedText = normalizeTranslatedMarkdown(content);
      ensureTranslationLooksApplied(
        chunk,
        normalizedText,
        settings.targetLanguage,
      );
      return normalizedText;
    }

    if (Array.isArray(content)) {
      const text = normalizeTranslatedMarkdown(
        content.map((part) => part.text || "").join(""),
      );
      if (text) {
        ensureTranslationLooksApplied(chunk, text, settings.targetLanguage);
        return text;
      }
    }

    throw new Error("Translation API returned empty content.");
  } catch (error) {
    return await retryBySplittingChunk(
      error,
      chunk,
      index,
      total,
      settings,
      splitDepth,
    );
  }
}

function normalizeTranslatedMarkdown(markdown: string) {
  const normalizedFences = normalizeMathCodeFences(markdown);
  return normalizeNonCodeSegments(
    normalizedFences,
    normalizeMathMarkdownSegment,
  ).trim();
}

function normalizeMathCodeFences(markdown: string) {
  return markdown.replace(
    /(^|\n)([ \t]*)(```|~~~)([^\n]*)\n([\s\S]*?)\n\2\3[ \t]*(?=\n|$)/g,
    (
      match,
      prefix: string,
      indent: string,
      _fence: string,
      info: string,
      body: string,
    ) => {
      const language = info.trim().toLowerCase();
      const isMathFence =
        /^(?:tex|latex|math|katex)$/.test(language) ||
        (!language && isLikelyLatexFormulaBlock(body.trim()));
      if (!isMathFence) {
        return match;
      }
      return renderDisplayMath(prefix, indent, body);
    },
  );
}

function normalizeMathMarkdownSegment(segment: string) {
  return wrapBareFormulaLines(
    normalizeInlineMathSpans(
      normalizeDisplayMathBlocks(normalizeLatexMathDelimiters(segment)),
    ),
  );
}

function isLikelyLatexFormulaBlock(value: string) {
  if (!value) {
    return false;
  }

  if (
    /^(?:const|let|var|function|class|import|export|def|return|if|for|while|#include)\b/m.test(
      value,
    )
  ) {
    return false;
  }

  return (
    /\\(?:begin|end|frac|sum|prod|int|lim|exp|log|sqrt|mathbf|boldsymbol|mathbb|mathcal|mathrm|operatorname|text|underbrace|overbrace|left|right|top|intercal|cdot|times|leq|geq|neq|approx|alpha|beta|gamma|delta|epsilon|theta|lambda|sigma|mu|partial|nabla)\b/.test(
      value,
    ) ||
    /(?:[_^]\s*\{|[A-Za-z0-9)}\]]\s*[_^]\s*[A-Za-z0-9{\\])/.test(value) ||
    /(?:=|≤|≥|≈|≠|∈|∑|∏|∫|→|←|↔)/.test(value)
  );
}

function normalizeNonCodeSegments(
  markdown: string,
  normalizeSegment: (segment: string) => string,
) {
  return markdown
    .split(
      /((?:^|\n)[ \t]*```[\s\S]*?\n[ \t]*```[ \t]*(?=\n|$)|(?:^|\n)[ \t]*~~~[\s\S]*?\n[ \t]*~~~[ \t]*(?=\n|$))/,
    )
    .map((segment) => {
      if (/^(?:\n)?[ \t]*(?:```|~~~)/.test(segment)) {
        return segment;
      }
      return normalizeSegment(segment);
    })
    .join("");
}

function normalizeLatexMathDelimiters(segment: string) {
  return segment
    .replace(
      /(^|\n)([ \t]*)\\\[([\s\S]*?)\\\][ \t]*(?=\n|$)/g,
      (_match, prefix: string, indent: string, body: string) =>
        renderDisplayMath(prefix, indent, body),
    )
    .replace(/\\\(([^()\n]+)\\\)/g, (match, body: string) => {
      const formula = normalizeFormulaExpression(body);
      return isLikelyInlineFormula(formula) ? `$${formula}$` : match;
    });
}

function normalizeDisplayMathBlocks(segment: string) {
  return segment
    .replace(
      /(^|\n)([ \t]*)\$\$[ \t]*\n([\s\S]*?)\n\2\$\$[ \t]*(?=\n|$)/g,
      (_match, prefix: string, indent: string, body: string) =>
        renderDisplayMath(prefix, indent, body),
    )
    .replace(
      /(^|\n)([ \t]*)\$\$[ \t]*([^$\n]+?)[ \t]*\$\$[ \t]*(?=\n|$)/g,
      (_match, prefix: string, indent: string, body: string) =>
        renderDisplayMath(prefix, indent, body),
    )
    .replace(
      /(^|\n)([ \t]*)(\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|split|aligned|matrix|pmatrix|bmatrix|cases)\}[\s\S]*?\\end\{\4\})[ \t]*(?=\n|$)/g,
      (_match, prefix: string, indent: string, body: string) =>
        renderDisplayMath(prefix, indent, body),
    );
}

function normalizeInlineMathSpans(segment: string) {
  return segment.replace(/\$([^$\n]+?)\$/g, (match, body: string) => {
    const formula = normalizeFormulaExpression(body);
    return isLikelyInlineFormula(formula) ? `$${formula}$` : match;
  });
}

function wrapBareFormulaLines(segment: string) {
  const lines = segment.replace(/\r\n/g, "\n").split("\n");
  const wrapped: string[] = [];
  let inDisplayMath = false;

  for (const line of lines) {
    if (/^\s*\$\$\s*$/.test(line)) {
      inDisplayMath = !inDisplayMath;
      wrapped.push(line);
      continue;
    }

    if (inDisplayMath || !isLikelyStandaloneFormulaLine(line)) {
      wrapped.push(line);
      continue;
    }

    const indent = line.match(/^\s*/)?.[0] || "";
    wrapped.push(renderDisplayMath("", indent, line.trim()));
  }

  return wrapped.join("\n");
}

function renderDisplayMath(prefix: string, indent: string, body: string) {
  const formula = normalizeFormulaExpression(body)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  if (!formula) {
    return `${prefix}${indent}$$\n${indent}$$`;
  }
  return `${prefix}${indent}$$\n${formula}\n${indent}$$`;
}

function isLikelyInlineFormula(value: string) {
  if (!value.trim()) {
    return false;
  }
  return (
    isLikelyLatexFormulaBlock(value) ||
    /^(?:\{?[A-Za-z\\][A-Za-z0-9\\]*\}?)(?:_\{[^{}\n]+\}|\^\{[^{}\n]+\})+$/.test(
      value.trim(),
    )
  );
}

function isLikelyStandaloneFormulaLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.includes("$")) {
    return false;
  }

  if (
    /^(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|\|)|^\|.*\|$|^[|:\-\s]+$/.test(trimmed)
  ) {
    return false;
  }

  if (
    /[，。；：！？、]/.test(trimmed) ||
    /[\u3400-\u9fff]/.test(trimmed) ||
    /\b(?:the|and|or|where|when|then|with|from|into|for|to|by|as|is|are|表示|其中)\b/i.test(
      trimmed,
    )
  ) {
    return false;
  }

  if (!isLikelyLatexFormulaBlock(trimmed)) {
    return false;
  }

  const compact = trimmed.replace(/\s+/g, "");
  const mathChars = (
    compact.match(/[\\{}_^=+\-*/<>()[\]|,.;:≤≥≈≠∈∑∏∫→←↔]/g) || []
  ).length;
  const ratio = compact ? mathChars / compact.length : 0;
  return (
    ratio >= 0.18 ||
    /\\(?:begin|frac|sum|prod|int|sqrt|mathbb|mathbf|operatorname)\b/.test(
      trimmed,
    )
  );
}

function normalizeFormulaExpression(value: string) {
  return value
    .trim()
    .replace(/^\$\$?|\$\$?$/g, "")
    .trim()
    .replace(/\\_/g, "_")
    .replace(/\\\^/g, "^")
    .replace(/([A-Za-z0-9}\\)\]])\s*_\s*\{([^{}\n]+)\}/g, "$1_{$2}")
    .replace(/([A-Za-z0-9}\\)\]])\s*\^\s*\{([^{}\n]+)\}/g, "$1^{$2}")
    .replace(/([A-Za-z0-9}\\)\]])\s*_\s*([A-Za-z0-9]+)/g, "$1_{$2}")
    .replace(/([A-Za-z0-9}\\)\]])\s*\^\s*([A-Za-z0-9]+)/g, "$1^{$2}")
    .replace(
      /(\{(?:\\?[A-Za-z][A-Za-z0-9]*|[0-9]+)\}(?:\^\{[^{}\n]+\})?)\*(\{[A-Za-z0-9]+\})/g,
      "$1_$2",
    )
    .replace(/(^|[^\\{])\b([A-Za-z])_\{([^{}\n]+)\}/g, "$1{$2}_{$3}")
    .replace(/(^|[^\\{])\b([A-Za-z])\^\{([^{}\n]+)\}/g, "$1{$2}^{$3}")
    .replace(/(\\[A-Za-z]+)_\{([^{}\n]+)\}/g, "{$1}_{$2}")
    .replace(/(\\[A-Za-z]+)\^\{([^{}\n]+)\}/g, "{$1}^{$2}");
}
function resolveTranslationEndpoint(baseURL: string) {
  const normalized = baseURL.replace(/\/+$/, "");
  if (/\/responses$/i.test(normalized)) {
    return {
      apiStyle: "responses" as const,
      url: normalized,
    };
  }

  if (/\/chat\/completions$/i.test(normalized)) {
    return {
      apiStyle: "chat" as const,
      url: normalized,
    };
  }

  return {
    apiStyle: "chat" as const,
    url: `${normalized}/chat/completions`,
  };
}

function extractResponsesText(response: ResponsesAPIResponse) {
  const message = response.output
    ?.filter((item) => item.type === "message")
    .at(-1);

  if (!message?.content?.length) {
    return "";
  }

  return message.content
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function createMessages(
  chunk: string,
  index: number,
  total: number,
  settings: TranslationSettings,
) {
  const messages: Array<{ role: "system" | "user"; content: string }> = [];
  const systemPrompt = settings.systemPrompt.trim();

  if (systemPrompt) {
    messages.push({
      role: "system",
      content: systemPrompt,
    });
  }

  messages.push({
    role: "user",
    content: [
      `请将下面的学术论文 Markdown 内容完整、准确地翻译成${settings.targetLanguage}。`,
      "要求：",
      "1. 保留 Markdown 结构和标题层级。",
      "2. 不要补充说明、总结、批注或任何额外前后缀。",
      "3. 逐句翻译，不要省略内容，不要把正文改写成摘要。",
      "4. 保留公式、变量、缩写、引用编号、文献标号和专业术语。",
      "5. 数学公式必须输出为标准 LaTeX Markdown：行内公式一律用 `$...$`，独立公式一律用 `$$` 单独成块包围；不要使用 `\\(...\\)`、`\\[...\\]`、代码块或 HTML 包装公式。",
      "6. 公式中的上下标必须使用 LaTeX 语法，例如 `${h}_{i}`、`${x}^{2}`、`$\\mathbf{W}_{q}$`；不要把下标写成乘法、星号、空格或普通文本。",
      "7. 如果输入中的公式没有 `$`/`$$` 定界符，或是 MinerU 输出的裸 LaTeX，也必须补上对应的 `$...$` 或 `$$...$$`。",
      "8. 公式内部的 LaTeX 命令、变量、上下标、空格和反斜杠保持原样；只翻译公式外的自然语言，必要时可翻译 `\\text{...}` / `\\mathrm{...}` 中的自然语言文字。",
      "9. 人名、机构名、数据集名、方法名优先采用学术场景常见译法，不确定时保留原文。",
      "10. 如果当前分段包含图表包装、details/summary、算法伪代码或明显非正文块，不要补写或解释它们，只处理正文内容。",
      "11. 如果当前分段从句子中间开始或结束，只翻译收到的内容，不要自行补全缺失上下文。",
      `12. 这是第 ${index + 1} / ${total} 个分段，请直接返回译文 Markdown。`,
      "",
      chunk,
    ].join("\n"),
  });

  return messages;
}

async function retryTranslationRequest<T>(requestFn: () => Promise<T>) {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_TRANSLATION_RETRIES; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      if (
        !isRetryableTranslationError(error) ||
        attempt === MAX_TRANSLATION_RETRIES - 1
      ) {
        throw error;
      }
      await delay(RETRY_BASE_DELAY_MS * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableTranslationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    message.includes("Network request failed") ||
    message.includes("Unknown network error") ||
    message.includes("timed out") ||
    message.includes("no HTTP response")
  ) {
    return true;
  }

  return RETRYABLE_STATUS_CODES.some((status) =>
    message.includes(`(${status})`),
  );
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryBySplittingChunk(
  error: unknown,
  chunk: string,
  index: number,
  total: number,
  settings: TranslationSettings,
  splitDepth: number,
) {
  if (
    !shouldRetryBySplitting(error) ||
    splitDepth >= MAX_TRANSLATION_SPLIT_DEPTH
  ) {
    throw error;
  }

  const parts = splitChunkForRetry(chunk);
  if (!parts) {
    throw error;
  }

  const translatedParts: string[] = [];
  for (const part of parts) {
    translatedParts.push(
      await translateSingleChunk(part, index, total, settings, splitDepth + 1),
    );
  }
  return translatedParts.join("\n\n");
}

function shouldRetryBySplitting(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("mostly unchanged from the source text");
}

function splitChunkForRetry(chunk: string) {
  const parts = chunk
    .split(/\n\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const midpoint = Math.floor(parts.length / 2);
  const left = parts.slice(0, midpoint).join("\n\n").trim();
  const right = parts.slice(midpoint).join("\n\n").trim();
  if (!left || !right) {
    return null;
  }
  return [left, right];
}

function ensureTranslationLooksApplied(
  source: string,
  translated: string,
  targetLanguage: string,
) {
  const normalizedSource = normalizeComparableText(source);
  const normalizedTranslated = normalizeComparableText(translated);
  if (!normalizedSource || !normalizedTranslated) {
    return;
  }

  const similarity = overlapRatio(normalizedSource, normalizedTranslated);
  const expectsChinese = /中文|汉语|汉字|chinese/i.test(targetLanguage);
  const hasEnoughChinese = countChineseChars(translated) >= 20;

  if (
    expectsChinese &&
    normalizedSource.length > 300 &&
    similarity > 0.88 &&
    !hasEnoughChinese
  ) {
    throw new Error(
      "Translation response appears to be mostly unchanged from the source text.",
    );
  }
}

function normalizeComparableText(value: string) {
  return value
    .replace(/\[\[\[ZPT_KEEP_BLOCK_[0-9]{4}\]\]\]/g, " ")
    .replace(/[`*_#>[\]()|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function overlapRatio(left: string, right: string) {
  const minLength = Math.min(left.length, right.length);
  if (minLength === 0) {
    return 0;
  }
  const sampleLength = Math.min(minLength, 1200);
  let same = 0;
  for (let index = 0; index < sampleLength; index++) {
    if (left[index] === right[index]) {
      same += 1;
    }
  }
  return same / sampleLength;
}

function countChineseChars(value: string) {
  const matches = value.match(/[\u3400-\u9fff]/g);
  return matches ? matches.length : 0;
}

const TRANSLATION_DIRECT_DOMAINS: Partial<
  Record<TranslationSettings["provider"], string[]>
> = {
  deepseek: ["api.deepseek.com", "deepseek.com"],
  doubao: ["ark.cn-beijing.volces.com", "volces.com"],
  glm: ["open.bigmodel.cn", "bigmodel.cn"],
};

const translationDirectHosts = new Set<string>();
let translationProxyBypassRegistered = false;
let translationProxyFilter: unknown = null;

function ensureTranslationDirectConnection(
  settings: TranslationSettings,
  endpointURL: string,
) {
  addTranslationDirectHosts(
    TRANSLATION_DIRECT_DOMAINS[settings.provider] || [],
  );

  const endpointHost = getURLHost(endpointURL);
  if (endpointHost && shouldBypassProxyForTranslationHost(endpointHost)) {
    translationDirectHosts.add(endpointHost);
  }

  if (!translationDirectHosts.size) {
    return;
  }

  registerTranslationProxyBypass();
  appendTranslationNoProxyPreference();
}

function addTranslationDirectHosts(hosts: string[]) {
  for (const host of hosts) {
    translationDirectHosts.add(host.toLowerCase());
  }
}

function shouldBypassProxyForTranslationHost(host: string) {
  return (
    host === "api.deepseek.com" ||
    host.endsWith(".deepseek.com") ||
    host === "ark.cn-beijing.volces.com" ||
    host.endsWith(".volces.com") ||
    host === "open.bigmodel.cn" ||
    host.endsWith(".bigmodel.cn")
  );
}

function getURLHost(url: string) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function registerTranslationProxyBypass() {
  if (translationProxyBypassRegistered) {
    return;
  }

  try {
    const components = (globalThis as any).Components;
    const proxyService = components.classes[
      "@mozilla.org/network/protocol-proxy-service;1"
    ].getService(components.interfaces.nsIProtocolProxyService);

    translationProxyFilter = {
      applyFilter(
        _proxyService: unknown,
        uri: { asciiHost?: string; host?: string },
        proxyInfo: unknown,
      ) {
        const host = (uri.asciiHost || uri.host || "").toLowerCase();
        return isTranslationDirectHost(host) ? null : proxyInfo;
      },
    };

    proxyService.registerFilter(translationProxyFilter, 0);
    translationProxyBypassRegistered = true;
  } catch (error) {
    Zotero.debug(
      `Translation proxy bypass filter unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function appendTranslationNoProxyPreference() {
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

    for (const host of translationDirectHosts) {
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
      `Translation proxy exclusion update failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isTranslationDirectHost(host: string) {
  if (!host) {
    return false;
  }

  for (const directHost of translationDirectHosts) {
    if (host === directHost || host.endsWith(`.${directHost}`)) {
      return true;
    }
  }
  return false;
}
