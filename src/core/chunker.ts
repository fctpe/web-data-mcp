import { countTokens, decodeTokens, encodeTokens } from './tokens.js';

export interface Chunk {
  content: string;
  tokenCount: number;
  index: number;
}

const PARAGRAPH_BREAK = /\n{2,}/;
const SENTENCE_BREAK = /(?<=[.!?])\s+/;

function splitOversized(segment: string, maxTokens: number): string[] {
  if (countTokens(segment) <= maxTokens) return [segment];

  const sentences = segment.split(SENTENCE_BREAK);
  const parts: string[] = [];
  for (const sentence of sentences) {
    if (countTokens(sentence) <= maxTokens) {
      parts.push(sentence);
      continue;
    }
    const tokens = encodeTokens(sentence);
    for (let start = 0; start < tokens.length; start += maxTokens) {
      parts.push(decodeTokens(tokens.slice(start, start + maxTokens)));
    }
  }
  return parts;
}

/**
 * Token-bounded chunking that respects paragraph and sentence boundaries.
 * Overlap is measured in tokens and taken from the tail of the previous
 * chunk, so downstream embeddings keep cross-chunk context.
 */
export function chunkText(
  text: string,
  opts: { maxTokens: number; overlapTokens: number },
): Chunk[] {
  const { maxTokens, overlapTokens } = opts;
  if (overlapTokens >= maxTokens) {
    throw new Error('overlapTokens must be smaller than maxTokens');
  }

  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized.length === 0) return [];

  const segments = normalized
    .split(PARAGRAPH_BREAK)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .flatMap((segment) => splitOversized(segment, maxTokens));

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    const content = current.join('\n\n');
    chunks.push({ content, tokenCount: countTokens(content), index: chunks.length });
  };

  for (const segment of segments) {
    const segmentTokens = countTokens(segment);
    if (currentTokens + segmentTokens > maxTokens && current.length > 0) {
      flush();
      if (overlapTokens > 0) {
        const previous = chunks[chunks.length - 1];
        if (previous) {
          const tail = encodeTokens(previous.content).slice(-overlapTokens);
          const overlapText = decodeTokens(tail);
          current = [overlapText];
          currentTokens = tail.length;
        } else {
          current = [];
          currentTokens = 0;
        }
      } else {
        current = [];
        currentTokens = 0;
      }
    }
    current.push(segment);
    currentTokens += segmentTokens;
  }
  flush();

  return chunks;
}
