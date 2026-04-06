#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { strFromU8, unzipSync } from "fflate";

const DEFAULT_SYSTEM_PROMPT =
  "你是一名学术论文翻译助手。请准确翻译为目标语言，保留 Markdown 结构、标题层级、列表、公式、缩写和专业术语；不要添加额外解释。";
const PRESERVE_TOKEN_PREFIX = "[[[ZPT_KEEP_BLOCK_";
const PRESERVE_TOKEN_SUFFIX = "]]]";
const REFERENCE_HEADINGS = [
  "references",
  "bibliography",
  "参考文献",
  "references and notes",
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const inputPath = args.input || args.i;
  if (!inputPath) {
    throw new Error("Missing --input <pdf-file-or-directory>.");
  }

  const apiKey = args.apiKey || process.env.TRANSLATION_API_KEY;
  if (!apiKey) {
    throw new Error("Missing API key. Use --api-key or TRANSLATION_API_KEY.");
  }

  const baseURL = (args.baseUrl ||
    args.apiBaseUrl ||
    process.env.TRANSLATION_BASE_URL ||
    "https://ark.cn-beijing.volces.com/api/v3/responses"
  ).replace(/\/+$/, "");
  const model =
    args.model ||
    process.env.TRANSLATION_MODEL ||
    "doubao-seed-1-8-251228";
  const targetLanguage =
    args.targetLanguage || process.env.TRANSLATION_TARGET_LANGUAGE || "简体中文";
  const chunkChars = Math.max(
    500,
    Number(args.chunkChars || process.env.TRANSLATION_CHUNK_CHARS || 2800),
  );
  const outputDir = path.resolve(
    args.outputDir || process.env.TRANSLATION_OUTPUT_DIR || "batch-output",
  );
  const systemPrompt =
    args.systemPrompt ||
    process.env.TRANSLATION_SYSTEM_PROMPT ||
    DEFAULT_SYSTEM_PROMPT;
  const extractor =
    args.extractor ||
    process.env.PDF_EXTRACTOR ||
    (args.mineruApiToken || process.env.MINERU_API_TOKEN ? "mineru" : "pdftotext");
  const mineruApiToken = args.mineruApiToken || process.env.MINERU_API_TOKEN || "";
  const mineruBaseURL = (
    args.mineruBaseUrl ||
    process.env.MINERU_BASE_URL ||
    "https://mineru.net/api/v4"
  ).replace(/\/+$/, "");
  const skipImages = parseBoolean(args.skipImages, true);
  const skipTables = parseBoolean(args.skipTables, true);
  const skipReferences = parseBoolean(args.skipReferences, false);

  const files = await collectPdfFiles(path.resolve(inputPath));
  if (!files.length) {
    throw new Error("No PDF files found.");
  }

  await fs.mkdir(outputDir, { recursive: true });

  for (const filePath of files) {
    console.log(`\n==> Processing ${filePath}`);

    const extractedMarkdown =
      extractor === "mineru"
        ? await extractMarkdownWithMinerU({
            filePath,
            apiToken: mineruApiToken,
            baseURL: mineruBaseURL,
          })
        : await extractPdfText(filePath, args.pages);

    if (!extractedMarkdown.trim()) {
      throw new Error(`No text extracted from ${filePath}`);
    }

    if (extractor !== "mineru") {
      console.log(
        "   using pdftotext fallback; MinerU image/table markdown cannot be preserved in this mode",
      );
    }

    const prepared = prepareMarkdownForTranslation(extractedMarkdown, {
      chunkChars,
      skipImages,
      skipTables,
      skipReferences,
    });

    const translatedChunks = [];
    for (let index = 0; index < prepared.chunks.length; index++) {
      console.log(`   translating chunk ${index + 1}/${prepared.chunks.length}`);
      translatedChunks.push(
        await translateChunk({
          apiKey,
          baseURL,
          model,
          systemPrompt,
          targetLanguage,
          chunk: prepared.chunks[index],
          index,
          total: prepared.chunks.length,
        }),
      );
    }

    const translatedText = prepared.chunks.length
      ? restorePreservedMarkdown(
          translatedChunks.join("\n\n"),
          prepared.preservedBlocks,
        )
      : prepared.cleanedMarkdown;

    const baseName = path.basename(filePath, path.extname(filePath));
    const safeBaseName = sanitizeFileName(baseName);
    const markdownPath = path.join(outputDir, `${safeBaseName}.translated.md`);

    await fs.writeFile(markdownPath, translatedText, "utf8");
    console.log(`   wrote ${markdownPath}`);
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const normalizedKey = toCamelCase(key);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
      args[normalizedKey] = true;
      continue;
    }

    args[key] = next;
    args[normalizedKey] = next;
    index += 1;
  }
  return args;
}

function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
  console.log(`Usage:
  node scripts/batch-translate-pdf.mjs --input <pdf-or-dir> [options]

Options:
  --extractor <mineru|pdftotext>  PDF extraction mode
  --base-url <url>                Translation endpoint or API base URL
  --api-key <key>                 Translation API key
  --model <name>                  Model name
  --target-language <v>           Target language, default: 简体中文
  --chunk-chars <n>               Chunk size, default: 2800
  --output-dir <dir>              Output directory, default: batch-output
  --pages <range>                 pdftotext page range, e.g. 1-5
  --system-prompt <text>          Custom system prompt
  --mineru-api-token <token>      MinerU API token
  --mineru-base-url <url>         MinerU base URL, default: https://mineru.net/api/v4
  --skip-images <true|false>      Preserve image markdown without translating it
  --skip-tables <true|false>      Preserve table/code markdown without translating it
  --skip-references <true|false>  Stop translating at references heading

Env:
  TRANSLATION_API_KEY
  TRANSLATION_BASE_URL
  TRANSLATION_MODEL
  TRANSLATION_TARGET_LANGUAGE
  TRANSLATION_CHUNK_CHARS
  TRANSLATION_OUTPUT_DIR
  MINERU_API_TOKEN
  MINERU_BASE_URL`);
}

async function collectPdfFiles(inputPath) {
  const stat = await fs.stat(inputPath);
  if (stat.isFile()) {
    return inputPath.toLowerCase().endsWith(".pdf") ? [inputPath] : [];
  }

  const entries = await fs.readdir(inputPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => path.join(inputPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

async function extractPdfText(filePath, pages) {
  const pageArgs = parsePages(pages);
  return await runCommand("pdftotext", [...pageArgs, "-layout", filePath, "-"]);
}

function parsePages(pages) {
  if (!pages) {
    return [];
  }

  const [from, to] = String(pages).split("-");
  const args = [];
  if (from) {
    args.push("-f", from);
  }
  if (to) {
    args.push("-l", to);
  }
  return args;
}

async function runCommand(command, args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(
        new Error(
          `${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`,
        ),
      );
    });
  });
}

async function extractMarkdownWithMinerU(params) {
  if (!params.apiToken) {
    throw new Error(
      "Missing MinerU API token. Use --mineru-api-token or MINERU_API_TOKEN.",
    );
  }

  const createResponse = await fetchJSON(`${params.baseURL}/file-urls/batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      files: [
        {
          name: path.basename(params.filePath),
          data_id: path.basename(params.filePath),
        },
      ],
      model_version: "vlm",
      language: "en",
      enable_table: true,
      enable_formula: true,
      is_ocr: false,
    }),
  });

  if (
    createResponse.code !== 0 ||
    !createResponse.data?.batch_id ||
    !createResponse.data?.file_urls?.length
  ) {
    throw new Error(`MinerU batch creation failed: ${createResponse.msg}`);
  }

  const binary = new Uint8Array(await fs.readFile(params.filePath));
  await putBinary(createResponse.data.file_urls[0], binary);

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = await fetchJSON(
      `${params.baseURL}/extract-results/batch/${createResponse.data.batch_id}`,
      {
        headers: {
          Authorization: `Bearer ${params.apiToken}`,
          Accept: "application/json",
        },
      },
    );

    if (result.code !== 0) {
      throw new Error(`MinerU polling failed: ${result.msg}`);
    }

    const entry = result.data?.extract_result?.[0];
    if (entry?.state === "failed") {
      throw new Error(
        `MinerU failed for ${path.basename(params.filePath)}: ${entry.err_msg || "unknown error"}`,
      );
    }

    if (entry?.state === "done" && entry.full_zip_url) {
      return await downloadFullMarkdown(entry.full_zip_url);
    }

    await delay(3000);
  }

  throw new Error("MinerU batch polling timed out.");
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text);
}

async function fetchBinary(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

async function putBinary(url, data) {
  const response = await fetch(url, {
    method: "PUT",
    body: data,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Upload failed (${response.status}): ${text.slice(0, 500)}`);
  }
}

async function downloadFullMarkdown(zipURL) {
  const archive = await fetchBinary(zipURL);
  const files = unzipSync(archive);
  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.endsWith("/full.md") || filePath === "full.md") {
      return strFromU8(content);
    }
  }
  throw new Error("MinerU result zip does not contain full.md.");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeLineEndings(text) {
  return text.replace(/\r\n/g, "\n").replace(/\u000c/g, "\n");
}

function prepareMarkdownForTranslation(markdown, settings) {
  const extracted = extractBlocks(normalizeLineEndings(markdown), settings);
  const translationMarkdown = extracted.blocks.join("\n\n").trim();
  const cleanedMarkdown = restorePreservedMarkdown(
    translationMarkdown,
    extracted.preservedBlocks,
  );

  return {
    cleanedMarkdown,
    translationMarkdown,
    chunks: extracted.translatableBlockCount
      ? chunkBlocks(extracted.blocks, settings.chunkChars)
      : [],
    preservedBlocks: extracted.preservedBlocks,
  };
}

function extractBlocks(markdown, settings) {
  const lines = markdown.split("\n");
  const blocks = [];
  const preservedBlocks = [];
  const current = [];
  const preservedCurrent = [];
  let translatableBlockCount = 0;
  let inFence = false;
  let htmlPreserveTag = null;

  const flushCurrent = () => {
    const block = current.join("\n").trim();
    current.length = 0;
    if (block) {
      blocks.push(block);
      translatableBlockCount += 1;
    }
  };

  const flushPreserved = () => {
    const block = preservedCurrent.join("\n").trim();
    preservedCurrent.length = 0;
    if (!block) {
      return;
    }
    const token = `${PRESERVE_TOKEN_PREFIX}${String(
      preservedBlocks.length + 1,
    ).padStart(4, "0")}${PRESERVE_TOKEN_SUFFIX}`;
    preservedBlocks.push({ token, content: block });
    blocks.push(token);
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (htmlPreserveTag) {
      flushCurrent();
      preservedCurrent.push(line);
      if (new RegExp(`</${htmlPreserveTag}\\b`, "i").test(line)) {
        htmlPreserveTag = null;
        flushPreserved();
      }
      continue;
    }

    if (settings.skipTables && /^```/.test(line)) {
      flushCurrent();
      preservedCurrent.push(line);
      inFence = !inFence;
      if (!inFence) {
        flushPreserved();
      }
      continue;
    }

    if (inFence && settings.skipTables) {
      preservedCurrent.push(line);
      continue;
    }

    if (settings.skipReferences && isReferenceHeading(line)) {
      flushCurrent();
      flushPreserved();
      break;
    }

    const openedTag = getOpenedHtmlPreserveTag(line, settings);
    if (openedTag) {
      flushCurrent();
      preservedCurrent.push(line);
      if (new RegExp(`</${openedTag}\\b`, "i").test(line)) {
        flushPreserved();
      } else {
        htmlPreserveTag = openedTag;
      }
      continue;
    }

    if (shouldPreserveLine(line, settings)) {
      flushCurrent();
      preservedCurrent.push(line);
      continue;
    }

    if (!line.trim()) {
      flushCurrent();
      flushPreserved();
      continue;
    }

    flushPreserved();
    current.push(line);
  }

  flushCurrent();
  flushPreserved();

  return {
    blocks,
    preservedBlocks,
    translatableBlockCount,
  };
}

function shouldPreserveLine(line, settings) {
  if (settings.skipImages && /^!\[.*\]\(.*\)$/.test(line)) {
    return true;
  }
  if (settings.skipTables) {
    if (/^\|.+\|$/.test(line)) return true;
    if (/^[:|\-\s]+$/.test(line)) return true;
  }
  if (settings.skipImages && /<\/?(img|figcaption)\b/i.test(line)) {
    return true;
  }
  return false;
}

function getOpenedHtmlPreserveTag(line, settings) {
  if (settings.skipTables && /<table\b/i.test(line)) {
    return "table";
  }
  if (settings.skipImages && /<figure\b/i.test(line)) {
    return "figure";
  }
  return null;
}

function isReferenceHeading(line) {
  const heading = line.replace(/^#+\s*/, "").trim().toLowerCase();
  return REFERENCE_HEADINGS.includes(heading);
}

function chunkBlocks(blocks, maxChars) {
  const chunks = [];
  let current = "";

  for (const block of blocks) {
    if (!current) {
      current = block;
      continue;
    }

    const next = `${current}\n\n${block}`;
    if (next.length <= maxChars) {
      current = next;
    } else {
      chunks.push(current);
      current = block;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function restorePreservedMarkdown(markdown, preservedBlocks) {
  let restored = markdown;
  for (const block of preservedBlocks) {
    restored = restored.split(block.token).join(block.content);
  }
  return restored;
}

async function translateChunk(params) {
  const endpoint = resolveTranslationEndpoint(params.baseURL);
  const body =
    endpoint.apiStyle === "responses"
      ? {
          model: params.model,
          temperature: 0.1,
          input: createMessages(params),
        }
      : {
          model: params.model,
          temperature: 0.1,
          messages: createMessages(params),
        };

  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();
  if (!response.ok) {
    throw new Error(
      `Translation request failed (${response.status}): ${raw.slice(0, 500)}`,
    );
  }

  const parsed = JSON.parse(raw);
  const text =
    endpoint.apiStyle === "responses"
      ? extractResponsesText(parsed)
      : extractChatText(parsed);

  if (!text) {
    throw new Error(`Translation API returned empty content: ${raw.slice(0, 500)}`);
  }

  return text;
}

function createMessages(params) {
  return [
    {
      role: "system",
      content: params.systemPrompt,
    },
    {
      role: "user",
      content: [
        `请将下面的 Markdown 内容翻译成${params.targetLanguage}。`,
        "要求：",
        "1. 直接返回译文 Markdown。",
        "2. 保留标题层级、列表、公式和段落结构。",
        "3. 不要补充解释。",
        "4. 保留缩写、术语和参考标号。",
        `5. 不要修改形如 ${PRESERVE_TOKEN_PREFIX}0001${PRESERVE_TOKEN_SUFFIX} 的占位符。`,
        `6. 这是第 ${params.index + 1} / ${params.total} 个分段。`,
        "",
        params.chunk,
      ].join("\n"),
    },
  ];
}

function resolveTranslationEndpoint(baseURL) {
  if (/\/responses$/i.test(baseURL)) {
    return { apiStyle: "responses", url: baseURL };
  }
  if (/\/chat\/completions$/i.test(baseURL)) {
    return { apiStyle: "chat", url: baseURL };
  }
  return { apiStyle: "chat", url: `${baseURL}/chat/completions` };
}

function extractResponsesText(response) {
  const message = response.output?.filter((item) => item.type === "message").at(-1);
  if (!message?.content?.length) {
    return "";
  }
  return message.content
    .map((part) => part.text || "")
    .join("")
    .trim();
}

function extractChatText(response) {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => part.text || "")
      .join("")
      .trim();
  }
  return "";
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  return !["false", "0", "no"].includes(String(value).toLowerCase());
}

function sanitizeFileName(value) {
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "_");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
