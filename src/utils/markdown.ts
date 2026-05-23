import type { TranslationSettings } from "../services/settings";

export interface MarkdownFilterStats {
  imagesRemoved: number;
  tablesRemoved: number;
  algorithmsRemoved: number;
  detailsRemoved: number;
  referencesRemoved: boolean;
  frontMatterBlocksRemoved: number;
  keptBlocks: number;
}

export interface PreparedMarkdown {
  cleanedMarkdown: string;
  chunks: string[];
  stats: MarkdownFilterStats;
}

const REFERENCE_HEADING_PATTERNS = [
  /^references$/i,
  /^bibliography$/i,
  /^references and notes$/i,
  /^works cited$/i,
  /^参考文献$/,
];

const MAIN_CONTENT_HEADINGS = [
  /^abstract$/i,
  /^摘要$/i,
  /^(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)]?\s+introduction$/i,
  /^(?:\d+(?:\.\d+)*|[ivxlcdm]+)[.)]?\s+(?:background|preliminaries|preliminary|related work|method|methods|approach|experiments?|evaluation|results?|discussion|conclusion)$/i,
  /^(?:introduction|background|preliminaries|preliminary|related work|method|methods|approach|experiments?|evaluation|results?|discussion|conclusion)$/i,
  /^(?:引言|方法|实验|结果|讨论|结论)$/i,
];

const FIGURE_CAPTION_PATTERNS = [
  /^(?:figure|fig\.?)\s*\d+[\s.:：-]/i,
  /^图\s*\d+[\s.:：-]/,
];
const TABLE_CAPTION_PATTERNS = [
  /^table\s*\d+[\s.:：-]/i,
  /^表\s*\d+[\s.:：-]/,
];
const DETAILS_SUMMARY_HINT_PATTERNS = [
  /<(?:summary)\b[^>]*>.*?(?:line|scatter|plot|heatmap|bar|chart|table|algorithm|伪代码|曲线|散点|热力|柱状|表格|算法).*?<\/summary>/i,
  /<(?:summary)\b[^>]*>.*?<\/summary>/i,
];
const ALGORITHM_TITLE_PATTERNS = [
  /^(?:algorithm|alg\.)\s*\d+[\s.:：-]/i,
  /^算法\s*\d+[\s.:：-]/,
];
const ALGORITHM_DIRECTIVE_PATTERNS = [
  /^(?:require|input|output|ensure|assume|given)\b/i,
  /^(?:输入|输出|要求|给定|已知|假设)\b/,
];

interface ExtractedBlocks {
  blocks: string[];
  stats: Omit<
    MarkdownFilterStats,
    "frontMatterBlocksRemoved" | "keptBlocks"
  >;
}

interface HtmlCaptureBlock {
  tag: "table" | "figure" | "details";
  lines: string[];
}

export function prepareMarkdownForTranslation(
  markdown: string,
  settings: TranslationSettings,
): PreparedMarkdown {
  const extracted = extractBlocks(markdown, settings);
  const filteredBlocks = settings.skipFrontMatter
    ? stripLeadingFrontMatter(extracted.blocks)
    : extracted.blocks;
  const frontMatterBlocksRemoved = Math.max(
    0,
    extracted.blocks.length - filteredBlocks.length,
  );
  const cleanedMarkdown = filteredBlocks.join("\n\n").trim();

  return {
    cleanedMarkdown,
    chunks: cleanedMarkdown ? chunkBlocks(filteredBlocks, settings.chunkChars) : [],
    stats: {
      ...extracted.stats,
      frontMatterBlocksRemoved,
      keptBlocks: filteredBlocks.length,
    },
  };
}

function extractBlocks(
  markdown: string,
  settings: TranslationSettings,
): ExtractedBlocks {
  const lines = normalizeLineEndings(markdown).split("\n");
  const blocks: string[] = [];
  const currentTextBlock: string[] = [];
  const stats = {
    imagesRemoved: 0,
    tablesRemoved: 0,
    algorithmsRemoved: 0,
    detailsRemoved: 0,
    referencesRemoved: false,
  };

  let activeHtmlBlock: HtmlCaptureBlock | null = null;
  let activeFence:
    | {
        marker: string;
        lines: string[];
      }
    | null = null;
  let activeMarkdownTable: string[] = [];
  let droppingTail = false;

  const finalizeTextBlock = () => {
    const block = currentTextBlock.join("\n").trim();
    currentTextBlock.length = 0;
    if (!block) {
      return;
    }

    const dropReason = getDroppedTextBlockReason(block, settings);
    if (dropReason === "image") {
      stats.imagesRemoved += 1;
      return;
    }
    if (dropReason === "table") {
      stats.tablesRemoved += 1;
      return;
    }
    if (dropReason === "algorithm") {
      stats.algorithmsRemoved += 1;
      return;
    }
    if (dropReason === "details") {
      stats.detailsRemoved += 1;
      return;
    }

    blocks.push(block);
  };

  const flushMarkdownTable = () => {
    if (!activeMarkdownTable.length) {
      return;
    }
    stats.tablesRemoved += 1;
    activeMarkdownTable = [];
  };

  const appendSanitizedText = (line: string) => {
    const sanitized = sanitizeInlineArtifacts(line, settings).trimEnd();
    if (!sanitized.trim()) {
      return;
    }
    currentTextBlock.push(sanitized);
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (droppingTail) {
      continue;
    }

    if (activeFence) {
      activeFence.lines.push(line);
      if (isFenceClosingLine(line, activeFence.marker)) {
        const fencedBlock = activeFence.lines.join("\n");
        const dropReason = getDroppedFenceReason(fencedBlock, settings);
        if (dropReason === "table") {
          stats.tablesRemoved += 1;
        } else if (dropReason === "algorithm") {
          stats.algorithmsRemoved += 1;
        } else {
          blocks.push(fencedBlock.trim());
        }
        activeFence = null;
      }
      continue;
    }

    if (activeHtmlBlock) {
      activeHtmlBlock.lines.push(line);
      if (new RegExp(`</${activeHtmlBlock.tag}\\b`, "i").test(line)) {
        countDroppedHtmlBlock(activeHtmlBlock, stats);
        activeHtmlBlock = null;
      }
      continue;
    }

    if (activeMarkdownTable.length) {
      if (isMarkdownTableLine(line)) {
        activeMarkdownTable.push(line);
        continue;
      }
      flushMarkdownTable();
    }

    if (settings.skipReferences && shouldDropTailFromHeading(line)) {
      finalizeTextBlock();
      stats.referencesRemoved = true;
      droppingTail = true;
      continue;
    }

    const fenceMarker = getFenceMarker(line);
    if (fenceMarker) {
      finalizeTextBlock();
      activeFence = {
        marker: fenceMarker,
        lines: [line],
      };
      continue;
    }

    const htmlSkipTag = getOpenedHtmlSkipTag(line, settings);
    if (htmlSkipTag) {
      finalizeTextBlock();
      const block = {
        tag: htmlSkipTag,
        lines: [line],
      } satisfies HtmlCaptureBlock;

      if (new RegExp(`</${htmlSkipTag}\\b`, "i").test(line)) {
        countDroppedHtmlBlock(block, stats);
      } else {
        activeHtmlBlock = block;
      }
      continue;
    }

    if (isDetailsControlLine(line, settings)) {
      finalizeTextBlock();
      stats.detailsRemoved += 1;
      continue;
    }

    if (settings.skipTables && isMarkdownTableLine(line)) {
      finalizeTextBlock();
      activeMarkdownTable.push(line);
      continue;
    }

    if (settings.skipImages && isStandaloneImageLine(line)) {
      finalizeTextBlock();
      stats.imagesRemoved += 1;
      continue;
    }

    if (!line.trim()) {
      finalizeTextBlock();
      continue;
    }

    appendSanitizedText(line);
  }

  finalizeTextBlock();
  flushMarkdownTable();

  if (activeFence) {
    const fencedBlock = activeFence.lines.join("\n");
    const dropReason = getDroppedFenceReason(fencedBlock, settings);
    if (dropReason === "table") {
      stats.tablesRemoved += 1;
    } else if (dropReason === "algorithm") {
      stats.algorithmsRemoved += 1;
    } else if (fencedBlock.trim()) {
      blocks.push(fencedBlock.trim());
    }
  }

  if (activeHtmlBlock) {
    countDroppedHtmlBlock(activeHtmlBlock, stats);
  }

  return {
    blocks,
    stats,
  };
}

function normalizeLineEndings(markdown: string) {
  return markdown.replace(/\r\n/g, "\n");
}

function sanitizeInlineArtifacts(
  line: string,
  settings: TranslationSettings,
) {
  let sanitized = line;

  if (settings.skipImages) {
    sanitized = sanitized
      .replace(/!\[[^\]]*]\([^)]*\)/g, "")
      .replace(/<img\b[^>]*\/?>/gi, "")
      .replace(/<\/?figcaption\b[^>]*>/gi, "");
  }

  if (settings.skipAlgorithms) {
    sanitized = sanitized
      .replace(/<\/?details\b[^>]*>/gi, "")
      .replace(/<\/?summary\b[^>]*>/gi, "");
  }

  return sanitized;
}

function isStandaloneImageLine(line: string) {
  const trimmed = line.trim();
  return (
    /^!\[[^\]]*]\([^)]*\)$/.test(trimmed) ||
    /^<\/?(?:img|figcaption)\b[^>]*>$/i.test(trimmed)
  );
}

function isDetailsControlLine(
  line: string,
  settings: TranslationSettings,
) {
  if (!settings.skipAlgorithms) {
    return false;
  }

  const trimmed = line.trim();
  return (
    /^<\/?details\b[^>]*>$/i.test(trimmed) ||
    /^<summary\b[^>]*>.*<\/summary>$/i.test(trimmed)
  );
}

function getOpenedHtmlSkipTag(
  line: string,
  settings: TranslationSettings,
): HtmlCaptureBlock["tag"] | null {
  if (settings.skipTables && /<table\b/i.test(line)) {
    return "table";
  }
  if (settings.skipImages && /<figure\b/i.test(line)) {
    return "figure";
  }
  if (settings.skipAlgorithms && /<details\b/i.test(line)) {
    return "details";
  }
  return null;
}

function getFenceMarker(line: string) {
  const match = line.trim().match(/^(```+|~~~+)/);
  return match?.[1] || "";
}

function isFenceClosingLine(line: string, marker: string) {
  return line.trim().startsWith(marker);
}

function getDroppedFenceReason(
  block: string,
  settings: TranslationSettings,
): "table" | "algorithm" | null {
  if (settings.skipTables && isTableLikeFenceBlock(block)) {
    return "table";
  }
  if (settings.skipAlgorithms && isAlgorithmLikeBlock(block)) {
    return "algorithm";
  }
  return null;
}

function isTableLikeFenceBlock(block: string) {
  const lines = block.split("\n");
  const header = lines[0]?.trim().toLowerCase() || "";
  const body = lines.slice(1, -1);

  if (
    /(table|csv|tsv|html)$/.test(header) ||
    body.some((line) => /<table\b/i.test(line))
  ) {
    return true;
  }

  const tableLikeLineCount = body.filter((line) => isMarkdownTableLine(line)).length;
  return tableLikeLineCount >= 2;
}

function isMarkdownTableLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }

  return /^\|.*\|$/.test(trimmed) || /^[|:\-\s]+$/.test(trimmed);
}

function getDroppedTextBlockReason(
  block: string,
  settings: TranslationSettings,
): "image" | "table" | "algorithm" | "details" | null {
  const firstLine = block.split("\n").map((line) => line.trim()).find(Boolean) || "";

  if (
    settings.skipAlgorithms &&
    (isDetailsLikeBlock(block) || isAlgorithmLikeBlock(block))
  ) {
    return isDetailsLikeBlock(block) ? "details" : "algorithm";
  }

  if (settings.skipImages && isFigureCaptionBlock(firstLine)) {
    return "image";
  }

  if (settings.skipTables && isTableCaptionBlock(firstLine)) {
    return "table";
  }

  return null;
}

function isFigureCaptionBlock(firstLine: string) {
  return FIGURE_CAPTION_PATTERNS.some((pattern) => pattern.test(firstLine));
}

function isTableCaptionBlock(firstLine: string) {
  return TABLE_CAPTION_PATTERNS.some((pattern) => pattern.test(firstLine));
}

function isDetailsLikeBlock(block: string) {
  if (/<\/?details\b/i.test(block) || /<\/?summary\b/i.test(block)) {
    return true;
  }

  return DETAILS_SUMMARY_HINT_PATTERNS.some((pattern) => pattern.test(block));
}

function isAlgorithmLikeBlock(block: string) {
  const lines = block
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return false;
  }

  const firstLine = lines[0];
  const stepLineCount = lines.filter((line) =>
    /^(?:\d+[:：.]|\d+\s)/.test(line),
  ).length;
  const directiveLineCount = lines.filter((line) =>
    ALGORITHM_DIRECTIVE_PATTERNS.some((pattern) => pattern.test(line)),
  ).length;
  const mathDenseLineCount = lines.filter((line) =>
    /(?:\\mathbb|\\in|\\times|\\text|[_^{}$]|←|:=)/.test(line),
  ).length;

  if (ALGORITHM_TITLE_PATTERNS.some((pattern) => pattern.test(firstLine))) {
    return true;
  }

  return (
    directiveLineCount >= 2 &&
    stepLineCount >= 3 &&
    mathDenseLineCount >= 2
  );
}

function countDroppedHtmlBlock(
  block: HtmlCaptureBlock,
  stats: ExtractedBlocks["stats"],
) {
  if (block.tag === "table") {
    stats.tablesRemoved += 1;
    return;
  }

  if (block.tag === "figure") {
    stats.imagesRemoved += 1;
    return;
  }

  stats.detailsRemoved += 1;
}

function shouldDropTailFromHeading(line: string) {
  const heading = line.replace(/^#+\s*/, "").trim();
  return REFERENCE_HEADING_PATTERNS.some((pattern) => pattern.test(heading));
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
