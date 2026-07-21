import { TOKENIZER_VERSION } from "./contracts.js";

export interface TokenOffset {
  readonly end: number;
  readonly start: number;
}

export interface VersionedTokenizer {
  readonly version: typeof TOKENIZER_VERSION;
  count(text: string): number;
  offsets(text: string): readonly TokenOffset[];
}

const TOKEN_PATTERN =
  /\p{L}[\p{L}\p{M}\p{N}'’-]*|\p{N}+(?:[.,]\p{N}+)*|[^\s]/gu;

export const unicodeTokenizerV1: VersionedTokenizer = Object.freeze({
  count(text: string): number {
    return [...text.matchAll(TOKEN_PATTERN)].length;
  },
  offsets(text: string): readonly TokenOffset[] {
    return [...text.matchAll(TOKEN_PATTERN)].map((match) => ({
      end: (match.index ?? 0) + match[0].length,
      start: match.index ?? 0,
    }));
  },
  version: TOKENIZER_VERSION,
});
