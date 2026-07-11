import { Tiktoken } from 'js-tiktoken/lite';
import cl100k_base from 'js-tiktoken/ranks/cl100k_base';

let encoder: Tiktoken | undefined;

function getEncoder(): Tiktoken {
  encoder ??= new Tiktoken(cl100k_base);
  return encoder;
}

export function countTokens(text: string): number {
  return getEncoder().encode(text).length;
}

export function encodeTokens(text: string): number[] {
  return getEncoder().encode(text);
}

export function decodeTokens(tokens: number[]): string {
  return getEncoder().decode(tokens);
}

export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  const tokens = getEncoder().encode(text);
  if (tokens.length <= maxTokens) {
    return { text, truncated: false };
  }
  return { text: getEncoder().decode(tokens.slice(0, maxTokens)), truncated: true };
}
