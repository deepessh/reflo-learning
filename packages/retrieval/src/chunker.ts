import type {
  NativeLocator,
  NormalizedBlock,
  NormalizedDocument,
} from "@reflo/ingestion";

import {
  CHUNKER_VERSION,
  EMBEDDING_INPUT_PROFILE_VERSION,
  SOURCE_SPAN_CONTRACT_VERSION,
  type SourceSpanMapping,
  type SourceSpanRecord,
} from "./contracts.js";
import { RetrievalError } from "./errors.js";
import { canonicalJson, sha256, stableUuid } from "./identity.js";
import { unicodeTokenizerV1, type VersionedTokenizer } from "./tokenizer.js";

const TARGET_TOKENS = 450;
const MIN_FRAGMENT_TOKENS = 150;
const MAX_EMBEDDING_INPUT_TOKENS = 700;

interface Atom {
  readonly mapping: SourceSpanMapping;
  readonly sectionIdentity: string;
  readonly sectionPath: readonly string[];
  readonly text: string;
}

export function chunkNormalizedDocument(input: {
  readonly document: NormalizedDocument;
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
  readonly tokenizer?: VersionedTokenizer;
}): readonly SourceSpanRecord[] {
  const tokenizer = input.tokenizer ?? unicodeTokenizerV1;
  if (tokenizer.version !== unicodeTokenizerV1.version) {
    throw new RetrievalError(
      "invalid_configuration",
      "unknown tokenizer profile",
    );
  }
  if (input.document.blocks.length === 0) {
    throw new RetrievalError(
      "invalid_chunk",
      "document contains no source blocks",
    );
  }

  const atoms = input.document.blocks.flatMap((block) =>
    splitBlock(block, tokenizer),
  );
  const groups: Atom[][] = [];
  let pending: Atom[] = [];

  const flush = (): void => {
    if (pending.length > 0) {
      groups.push(pending);
      pending = [];
    }
  };

  for (const atom of atoms) {
    if (
      pending.length > 0 &&
      pending[0]?.sectionIdentity !== atom.sectionIdentity
    ) {
      flush();
    }
    const candidate = [...pending, atom];
    const candidateTokens = tokenizer.count(embeddingInput(candidate));
    const pendingTokens =
      pending.length === 0 ? 0 : tokenizer.count(embeddingInput(pending));
    if (
      pending.length > 0 &&
      candidateTokens > TARGET_TOKENS &&
      (pendingTokens >= MIN_FRAGMENT_TOKENS ||
        candidateTokens > MAX_EMBEDDING_INPUT_TOKENS)
    ) {
      flush();
    }
    pending.push(atom);
    if (tokenizer.count(embeddingInput(pending)) > MAX_EMBEDDING_INPUT_TOKENS) {
      throw new RetrievalError(
        "invalid_chunk",
        "embedding input exceeds chunk-v1 hard token cap",
      );
    }
  }
  flush();

  return groups.map((group, chunkOrder) =>
    buildSpan({
      chunkOrder,
      document: input.document,
      group,
      ownerScopeId: input.ownerScopeId,
      sourceDocumentId: input.sourceDocumentId,
      tokenizer,
    }),
  );
}

function splitBlock(
  block: NormalizedBlock,
  tokenizer: VersionedTokenizer,
): readonly Atom[] {
  const sectionPath = sectionPathFor(block.locator);
  const sectionIdentity = canonicalJson({
    locator: sectionIdentityFor(block.locator),
    sectionPath,
  });
  const breadcrumbTokens = tokenizer.count(breadcrumb(sectionPath));
  const hardContentLimit = MAX_EMBEDDING_INPUT_TOKENS - breadcrumbTokens;
  if (hardContentLimit < 1) {
    throw new RetrievalError(
      "invalid_chunk",
      "section breadcrumb is too large",
    );
  }
  const offsets = tokenizer.offsets(block.text);
  if (offsets.length <= hardContentLimit) {
    return [atomFor(block, 0, block.text.length, sectionIdentity, sectionPath)];
  }

  const sliceSize = Math.min(TARGET_TOKENS, hardContentLimit);
  const atoms: Atom[] = [];
  for (let index = 0; index < offsets.length; index += sliceSize) {
    const start =
      index === 0 ? 0 : (offsets[index]?.start ?? block.text.length);
    const next = offsets[index + sliceSize];
    const end = next?.start ?? block.text.length;
    atoms.push(atomFor(block, start, end, sectionIdentity, sectionPath));
  }
  return atoms;
}

function atomFor(
  block: NormalizedBlock,
  textStart: number,
  textEnd: number,
  sectionIdentity: string,
  sectionPath: readonly string[],
): Atom {
  const text = block.text.slice(textStart, textEnd);
  if (text.length === 0) {
    throw new RetrievalError("invalid_chunk", "empty source-span fragment");
  }
  return {
    mapping: {
      canonicalEnd: block.canonicalStart + textEnd,
      canonicalStart: block.canonicalStart + textStart,
      locator: block.locator,
      overlap: false,
      sourceBlockOrder: block.order,
      textEnd,
      textStart,
    },
    sectionIdentity,
    sectionPath,
    text,
  };
}

function buildSpan(input: {
  readonly chunkOrder: number;
  readonly document: NormalizedDocument;
  readonly group: readonly Atom[];
  readonly ownerScopeId: string;
  readonly sourceDocumentId: string;
  readonly tokenizer: VersionedTokenizer;
}): SourceSpanRecord {
  const first = required(input.group[0]);
  const last = required(input.group.at(-1));
  const canonicalText = input.group.map((atom) => atom.text).join("\n\n");
  const embedding = embeddingInput(input.group);
  if (input.tokenizer.count(embedding) > MAX_EMBEDDING_INPUT_TOKENS) {
    throw new RetrievalError("invalid_chunk", "invalid embedding input size");
  }
  const mappings = input.group.map((atom) => atom.mapping);
  const pages = mappings.flatMap((mapping) =>
    mapping.locator.kind === "pdf" ? [mapping.locator.page] : [],
  );
  const textHash = sha256(canonicalText);
  const identity = {
    chunkerVersion: CHUNKER_VERSION,
    contractVersion: SOURCE_SPAN_CONTRACT_VERSION,
    mappings,
    parserVersion: input.document.parserVersion,
    sourceDocumentId: input.sourceDocumentId,
    textHash,
    tokenizerVersion: input.tokenizer.version,
  };
  return {
    canonicalEnd: last.mapping.canonicalEnd,
    canonicalStart: first.mapping.canonicalStart,
    canonicalText,
    chunkOrder: input.chunkOrder,
    chunkerVersion: CHUNKER_VERSION,
    contractVersion: SOURCE_SPAN_CONTRACT_VERSION,
    embeddingInput: embedding,
    embeddingInputHash: sha256(embedding),
    embeddingInputProfileVersion: EMBEDDING_INPUT_PROFILE_VERSION,
    id: stableUuid(identity),
    mappings,
    ownerScopeId: input.ownerScopeId,
    pageEnd: pages.length === 0 ? null : Math.max(...pages),
    pageStart: pages.length === 0 ? null : Math.min(...pages),
    parserVersion: input.document.parserVersion,
    sectionPath: first.sectionPath,
    sourceDocumentId: input.sourceDocumentId,
    textHash,
    tokenizerVersion: input.tokenizer.version,
  };
}

function embeddingInput(atoms: readonly Atom[]): string {
  const first = required(atoms[0]);
  return `${breadcrumb(first.sectionPath)}${atoms
    .map((atom) => atom.text)
    .join("\n\n")}`;
}

function breadcrumb(sectionPath: readonly string[]): string {
  return sectionPath.length === 0
    ? ""
    : `[Section: ${sectionPath.join(" > ")}]\n`;
}

function sectionPathFor(locator: NativeLocator): readonly string[] {
  return locator.kind === "docx" ? locator.headingPath : locator.sectionPath;
}

function sectionIdentityFor(locator: NativeLocator): unknown {
  if (locator.kind === "pdf") {
    return { kind: locator.kind };
  }
  if (locator.kind === "epub") {
    return {
      kind: locator.kind,
      resource: locator.resource,
      spineItem: locator.spineItem,
    };
  }
  return { kind: locator.kind, section: locator.section };
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new RetrievalError("invalid_chunk", "missing chunk content");
  }
  return value;
}
