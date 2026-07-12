import { countTokens, decodeTokens, encodeTokens } from './tokens.js';

export interface Chunk {
  content: string;
  tokenCount: number;
  index: number;
}

const PARAGRAPH_BREAK = /\n{2,}/;
const SENTENCE_BREAK = /(?<=[.!?])\s+/;
const SEPARATOR = '\n\n';
const SEPARATOR_TOKENS = countTokens(SEPARATOR);

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
 * The bound is strict: separator tokens are accounted for, and the overlap
 * seeded from the previous chunk's tail counts against the next chunk's
 * budget (overlap is skipped for a chunk when it would not leave room for
 * the next segment). maxTokens must leave headroom for one split segment.
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

  // Individual segments are pre-split below the budget minus separator room,
  // so any single segment always fits into a fresh chunk.
  const segmentBudget = Math.max(1, maxTokens - SEPARATOR_TOKENS);
  const segments = normalized
    .split(PARAGRAPH_BREAK)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .flatMap((segment) => splitOversized(segment, segmentBudget));

  const chunks: Chunk[] = [];
  let current: string[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (current.length === 0) return;
    const content = current.join(SEPARATOR);
    chunks.push({ content, tokenCount: countTokens(content), index: chunks.length });
  };

  for (const segment of segments) {
    const segmentTokens = countTokens(segment);
    const joinCost = current.length > 0 ? SEPARATOR_TOKENS : 0;

    if (current.length > 0 && currentTokens + joinCost + segmentTokens > maxTokens) {
      flush();
      current = [];
      currentTokens = 0;

      if (overlapTokens > 0) {
        const previous = chunks[chunks.length - 1];
        if (previous) {
          const tail = encodeTokens(previous.content).slice(-overlapTokens);
          // Seed overlap only when it leaves room for the segment itself.
          if (tail.length + SEPARATOR_TOKENS + segmentTokens <= maxTokens) {
            current = [decodeTokens(tail)];
            currentTokens = tail.length;
          }
        }
      }
    }

    current.push(segment);
    currentTokens += segmentTokens + (current.length > 1 ? SEPARATOR_TOKENS : 0);
  }
  flush();

  return chunks;
}
