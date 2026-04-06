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

export async function translateMarkdownChunks(
  chunks: string[],
  settings: TranslationSettings,
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

  const translated: string[] = [];
  for (let index = 0; index < chunks.length; index++) {
    translated.push(
      await translateSingleChunk(chunks[index], index, chunks.length, settings),
    );
  }
  return translated.join("\n\n");
}

async function translateSingleChunk(
  chunk: string,
  index: number,
  total: number,
  settings: TranslationSettings,
) {
  const endpoint = resolveTranslationEndpoint(settings.baseURL);
  if (endpoint.apiStyle === "responses") {
    const response = await fetchJSON<ResponsesAPIResponse>(endpoint.url, {
      method: "POST",
      timeoutMs: 120000,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.model,
        temperature: settings.temperature,
        input: [
          {
            role: "system",
            content: settings.systemPrompt,
          },
          {
            role: "user",
            content: [
              `请将下面的 Markdown 内容翻译成${settings.targetLanguage}。`,
              "要求：",
              "1. 保留 Markdown 结构和标题层级。",
              "2. 不要补充说明、总结或注释。",
              "3. 保留公式、变量、缩写、参考标号和专业术语。",
              "4. 不要修改形如 [[[ZPT_KEEP_BLOCK_0001]]] 的占位符。",
              `5. 这是第 ${index + 1} / ${total} 个分段，请直接返回译文 Markdown。`,
              "",
              chunk,
            ].join("\n"),
          },
        ],
      }),
    });

    if (response.error?.message) {
      throw new Error(`Translation API error: ${response.error.message}`);
    }

    const text = extractResponsesText(response);
    if (text) {
      return text;
    }
    throw new Error("Translation API returned empty content.");
  }

  const response = await fetchJSON<ChatCompletionResponse>(endpoint.url, {
    method: "POST",
    timeoutMs: 120000,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.model,
      temperature: settings.temperature,
      messages: [
        {
          role: "system",
          content: settings.systemPrompt,
        },
        {
          role: "user",
          content: [
            `请将下面的 Markdown 内容翻译成${settings.targetLanguage}。`,
            "要求：",
            "1. 保留 Markdown 结构和标题层级。",
            "2. 不要补充说明、总结或注释。",
            "3. 保留公式、变量、缩写、参考标号和专业术语。",
            "4. 不要修改形如 [[[ZPT_KEEP_BLOCK_0001]]] 的占位符。",
            `5. 这是第 ${index + 1} / ${total} 个分段，请直接返回译文 Markdown。`,
            "",
            chunk,
          ].join("\n"),
        },
      ],
    }),
  });

  if (response.error?.message) {
    throw new Error(`Translation API error: ${response.error.message}`);
  }

  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => part.text || "")
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }

  throw new Error("Translation API returned empty content.");
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
