import type { TranslationSettings } from "../services/settings";

interface PreparedMarkdown {
  cleanedMarkdown: string;
  chunks: string[];
}

const REFERENCE_HEADINGS = [
  "references",
  "bibliography",
  "参考文献",
  "references and notes",
];

export function prepareMarkdownForTranslation(
  markdown: string,
  settings: TranslationSettings,
): PreparedMarkdown {
  const blocks = extractBlocks(markdown, settings);
  const cleanedMarkdown = blocks.join("\n\n").trim();
  return {
    cleanedMarkdown,
    chunks: chunkBlocks(blocks, settings.chunkChars),
  };
}

function extractBlocks(markdown: string, settings: TranslationSettings) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const blocks: string[] = [];
  const current: string[] = [];
  let inFence = false;

  const flush = () => {
    const block = current.join("\n").trim();
    current.length = 0;
    if (block) {
      blocks.push(block);
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (/^```/.test(line)) {
      inFence = !inFence;
      if (settings.skipTables) {
        flush();
        continue;
      }
    }

    if (inFence && settings.skipTables) {
      continue;
    }

    if (settings.skipReferences && isReferenceHeading(line)) {
      flush();
      break;
    }

    if (shouldSkipLine(line, settings)) {
      flush();
      continue;
    }

    if (!line.trim()) {
      flush();
      continue;
    }

    current.push(line);
  }

  flush();
  return blocks;
}

function shouldSkipLine(line: string, settings: TranslationSettings) {
  if (settings.skipImages) {
    if (/^!\[.*\]\(.*\)$/.test(line)) return true;
    if (/<\/?(img|figure|figcaption)\b/i.test(line)) return true;
  }

  if (settings.skipTables) {
    if (/^\|.+\|$/.test(line)) return true;
    if (/^[:|\-\s]+$/.test(line)) return true;
    if (/<\/?table\b/i.test(line)) return true;
  }

  return false;
}

function isReferenceHeading(line: string) {
  const heading = line.replace(/^#+\s*/, "").trim().toLowerCase();
  return REFERENCE_HEADINGS.includes(heading);
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
