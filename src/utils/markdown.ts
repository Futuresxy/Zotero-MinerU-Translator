import type { TranslationSettings } from "../services/settings";

export interface PreservedBlock {
  token: string;
  content: string;
}

interface PreparedMarkdown {
  cleanedMarkdown: string;
  translationMarkdown: string;
  chunks: string[];
  preservedBlocks: PreservedBlock[];
}

const TAIL_PRESERVE_HEADING_PATTERNS = [
  /^references$/i,
  /^bibliography$/i,
  /^references and notes$/i,
  /^appendix$/i,
  /^appendices$/i,
  /^supplement(?:ary)?(?: materials?)?$/i,
  /^参考文献$/,
  /^附录$/,
];
const MAIN_CONTENT_HEADINGS = [
  /^abstract$/i,
  /^摘要$/i,
  /^(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)]?\s+introduction$/i,
  /^(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)]?\s+(?:background|preliminaries|preliminary|related work|method|methods|approach|experiments?|evaluation|results?|discussion|conclusion|appendix)$/i,
  /^(?:introduction|background|preliminaries|preliminary|related work|method|methods|approach|experiments?|evaluation|results?|discussion|conclusion|appendix)$/i,
  /^(?:引言|方法|实验|结果|讨论|结论|附录)$/i,
];

const PRESERVE_TOKEN_PREFIX = "[[[ZPT_KEEP_BLOCK_";
const PRESERVE_TOKEN_SUFFIX = "]]]";

export function prepareMarkdownForTranslation(
  markdown: string,
  settings: TranslationSettings,
): PreparedMarkdown {
  const extracted = extractBlocks(markdown, settings);
  const translationBlocks = settings.skipFrontMatter
    ? stripLeadingFrontMatter(extracted.blocks)
    : extracted.blocks;
  const translationMarkdown = translationBlocks.join("\n\n").trim();
  const cleanedMarkdown = restorePreservedMarkdown(
    translationMarkdown,
    extracted.preservedBlocks,
  );

  return {
    cleanedMarkdown,
    translationMarkdown,
    chunks: countTranslatableBlocks(translationBlocks)
      ? chunkBlocks(translationBlocks, settings.chunkChars)
      : [],
    preservedBlocks: extracted.preservedBlocks,
  };
}

export function restorePreservedMarkdown(
  markdown: string,
  preservedBlocks: PreservedBlock[],
) {
  let restored = markdown;
  for (const block of preservedBlocks) {
    restored = restored.split(block.token).join(block.content);
  }
  return restored;
}

function extractBlocks(markdown: string, settings: TranslationSettings) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  const preservedBlocks: PreservedBlock[] = [];
  const current: string[] = [];
  const preservedCurrent: string[] = [];
  let translatableBlockCount = 0;
  let inFence = false;
  let htmlPreserveTag: "table" | "figure" | null = null;
  let preserveTail = false;

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

    if (preserveTail) {
      flushCurrent();
      preservedCurrent.push(line);
      continue;
    }

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

    if (settings.skipReferences && shouldPreserveTailFromHeading(line)) {
      flushCurrent();
      flushPreserved();
      preservedCurrent.push(line);
      preserveTail = true;
      continue;
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

function shouldPreserveLine(line: string, settings: TranslationSettings) {
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

function getOpenedHtmlPreserveTag(
  line: string,
  settings: TranslationSettings,
): "table" | "figure" | null {
  if (settings.skipTables && /<table\b/i.test(line)) {
    return "table";
  }
  if (settings.skipImages && /<figure\b/i.test(line)) {
    return "figure";
  }
  return null;
}

function shouldPreserveTailFromHeading(line: string) {
  const heading = line.replace(/^#+\s*/, "").trim();
  return TAIL_PRESERVE_HEADING_PATTERNS.some((pattern) => pattern.test(heading));
}

function chunkBlocks(blocks: string[], maxChars: number) {
  const chunks: string[] = [];
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

function stripLeadingFrontMatter(blocks: string[]) {
  const firstContentIndex = blocks.findIndex((block) => isMainContentStart(block));
  if (firstContentIndex <= 0) {
    return blocks;
  }
  return blocks.slice(firstContentIndex);
}

function isMainContentStart(block: string) {
  if (!block || isPreservedToken(block)) {
    return false;
  }

  const firstLine = block
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) {
    return false;
  }

  const normalized = firstLine.replace(/^#+\s*/, "").trim();
  return MAIN_CONTENT_HEADINGS.some((pattern) => pattern.test(normalized));
}

function countTranslatableBlocks(blocks: string[]) {
  return blocks.filter((block) => !isPreservedToken(block)).length;
}

function isPreservedToken(block: string) {
  return (
    block.startsWith(PRESERVE_TOKEN_PREFIX) &&
    block.endsWith(PRESERVE_TOKEN_SUFFIX)
  );
}
