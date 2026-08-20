import {
  buildReticulumChatAuthorTreeSnapshot,
  reticulumChatAuthorTreeHeadKey,
  type ReticulumChatAuthorSequenceHead,
  type ReticulumChatAuthorTreeSnapshot,
} from './reticulum-chat-author-tree';

export const RETICULUM_CHAT_AUTHOR_MANIFEST_VERSION = 1;
export const RETICULUM_CHAT_AUTHOR_MANIFEST_MAX_HEADS = 100_000;
export const RETICULUM_CHAT_AUTHOR_MANIFEST_MAX_COMPRESSED_BYTES =
  8 * 1024 * 1024;
export const RETICULUM_CHAT_AUTHOR_MANIFEST_MAX_DECOMPRESSED_BYTES =
  32 * 1024 * 1024;
const RETICULUM_CHAT_AUTHOR_MANIFEST_MAX_ADDRESS_LENGTH = 128;

export type ReticulumChatAuthorManifest = {
  v: 1;
  g: number;
  root: string;
  base?: string;
  full: boolean;
  count: number;
  heads: Array<[string, string, number]>;
};

function snapshotHeads(
  snapshot: ReticulumChatAuthorTreeSnapshot
): ReticulumChatAuthorSequenceHead[] {
  return snapshot.buckets.flat();
}

export function buildReticulumChatAuthorManifest(
  target: ReticulumChatAuthorTreeSnapshot,
  base?: ReticulumChatAuthorTreeSnapshot | null
): ReticulumChatAuthorManifest {
  const targetHeads = snapshotHeads(target);
  let canDelta =
    !!base && base.groupId === target.groupId && base.root !== target.root;
  let heads = targetHeads;
  if (canDelta) {
    const baseHeads = new Map(
      snapshotHeads(base!).map((head) => [
        reticulumChatAuthorTreeHeadKey(head),
        head.maxSeq,
      ])
    );
    const targetByKey = new Map(
      targetHeads.map((head) => [
        reticulumChatAuthorTreeHeadKey(head),
        head.maxSeq,
      ])
    );
    // Author streams are append-only. A base containing a missing stream or a
    // higher sequence cannot be represented by an overwrite-only delta, so
    // send a full manifest instead of relying on an unsafe subtraction.
    if (
      [...baseHeads].some(
        ([key, maxSeq]) =>
          !targetByKey.has(key) || Number(targetByKey.get(key)) < maxSeq
      )
    ) {
      canDelta = false;
    }
    heads = canDelta
      ? targetHeads.filter(
          (head) =>
            baseHeads.get(reticulumChatAuthorTreeHeadKey(head)) !== head.maxSeq
        )
      : targetHeads;
  }
  return {
    v: RETICULUM_CHAT_AUTHOR_MANIFEST_VERSION,
    g: target.groupId,
    root: target.root,
    ...(canDelta ? { base: base!.root } : {}),
    full: !canDelta,
    count: target.count,
    heads: heads.map((head) => [
      head.authorAddress,
      head.authorStreamId,
      head.maxSeq,
    ]),
  };
}

export function serializeReticulumChatAuthorManifest(
  manifest: ReticulumChatAuthorManifest
): string {
  return JSON.stringify(manifest);
}

export function parseReticulumChatAuthorManifest(
  candidate: unknown
): ReticulumChatAuthorManifest | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    return null;
  const value = candidate as Partial<ReticulumChatAuthorManifest>;
  if (
    value.v !== RETICULUM_CHAT_AUTHOR_MANIFEST_VERSION ||
    !Number.isInteger(value.g) ||
    Number(value.g) <= 0 ||
    typeof value.root !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(value.root) ||
    typeof value.full !== 'boolean' ||
    !Number.isSafeInteger(value.count) ||
    Number(value.count) < 0 ||
    Number(value.count) > RETICULUM_CHAT_AUTHOR_MANIFEST_MAX_HEADS ||
    !Array.isArray(value.heads) ||
    value.heads.length > RETICULUM_CHAT_AUTHOR_MANIFEST_MAX_HEADS
  ) {
    return null;
  }
  if (
    value.full === false &&
    (typeof value.base !== 'string' || !/^[0-9a-f]{64}$/i.test(value.base))
  ) {
    return null;
  }
  if (value.full === true && value.base != null) return null;
  const heads: Array<[string, string, number]> = [];
  const seen = new Set<string>();
  for (const entry of value.heads) {
    if (!Array.isArray(entry) || entry.length !== 3) return null;
    const authorAddress = typeof entry[0] === 'string' ? entry[0].trim() : '';
    const authorStreamId =
      typeof entry[1] === 'string' ? entry[1].trim().toLowerCase() : '';
    const maxSeq = Number(entry[2]);
    if (
      !authorAddress ||
      authorAddress.length >
        RETICULUM_CHAT_AUTHOR_MANIFEST_MAX_ADDRESS_LENGTH ||
      !/^[0-9a-f]{32}$/.test(authorStreamId) ||
      !Number.isSafeInteger(maxSeq) ||
      maxSeq <= 0
    ) {
      return null;
    }
    const key = `${authorAddress}\u0000${authorStreamId}`;
    if (seen.has(key)) return null;
    seen.add(key);
    heads.push([authorAddress, authorStreamId, maxSeq]);
  }
  if (value.full && heads.length !== value.count) return null;
  return {
    v: RETICULUM_CHAT_AUTHOR_MANIFEST_VERSION,
    g: Number(value.g),
    root: value.root.toLowerCase(),
    ...(value.full === false ? { base: value.base!.toLowerCase() } : {}),
    full: value.full,
    count: Number(value.count),
    heads,
  };
}

export function materializeReticulumChatAuthorManifest(
  manifest: ReticulumChatAuthorManifest,
  baseHeads: ReticulumChatAuthorSequenceHead[] = []
): ReticulumChatAuthorTreeSnapshot | null {
  const heads = new Map<string, ReticulumChatAuthorSequenceHead>();
  if (!manifest.full) {
    for (const head of baseHeads) {
      heads.set(reticulumChatAuthorTreeHeadKey(head), { ...head });
    }
  }
  for (const [authorAddress, authorStreamId, maxSeq] of manifest.heads) {
    const head = { authorAddress, authorStreamId, maxSeq };
    const key = reticulumChatAuthorTreeHeadKey(head);
    const prior = heads.get(key);
    // Author streams are append-only. A delta may advance a stream, but it
    // must never rewrite a known base head backwards.
    if (!manifest.full && prior && maxSeq < prior.maxSeq) return null;
    heads.set(key, head);
  }
  if (heads.size !== manifest.count) return null;
  const snapshot = buildReticulumChatAuthorTreeSnapshot(manifest.g, [
    ...heads.values(),
  ]);
  return snapshot.root === manifest.root ? snapshot : null;
}
