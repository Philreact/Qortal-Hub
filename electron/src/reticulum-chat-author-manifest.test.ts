import { describe, expect, it } from 'vitest';
import { buildReticulumChatAuthorTreeSnapshot } from './reticulum-chat-author-tree';
import {
  buildReticulumChatAuthorManifest,
  materializeReticulumChatAuthorManifest,
  parseReticulumChatAuthorManifest,
} from './reticulum-chat-author-manifest';

const head = (authorAddress: string, streamByte: string, maxSeq: number) => ({
  authorAddress,
  authorStreamId: streamByte.repeat(32),
  maxSeq,
});

describe('reticulum chat author manifests', () => {
  it('round-trips a full manifest and verifies its root', () => {
    const target = buildReticulumChatAuthorTreeSnapshot(1144, [
      head('Qalice', 'a', 8),
      head('Qbob', 'b', 13),
    ]);
    const manifest = buildReticulumChatAuthorManifest(target);
    const parsed = parseReticulumChatAuthorManifest(
      JSON.parse(JSON.stringify(manifest))
    );

    expect(parsed?.full).toBe(true);
    expect(
      parsed && materializeReticulumChatAuthorManifest(parsed)
    ).toMatchObject({ root: target.root, count: 2 });
  });

  it('applies an append-only delta to a known base', () => {
    const baseHeads = [head('Qalice', 'a', 8), head('Qbob', 'b', 13)];
    const targetHeads = [
      head('Qalice', 'a', 11),
      head('Qbob', 'b', 13),
      head('Qcarol', 'c', 1),
    ];
    const base = buildReticulumChatAuthorTreeSnapshot(1144, baseHeads);
    const target = buildReticulumChatAuthorTreeSnapshot(1144, targetHeads);
    const manifest = buildReticulumChatAuthorManifest(target, base);

    expect(manifest).toMatchObject({ full: false, base: base.root, count: 3 });
    expect(manifest.heads).toHaveLength(2);
    expect(
      materializeReticulumChatAuthorManifest(manifest, baseHeads)?.root
    ).toBe(target.root);
  });

  it('falls back to a full manifest when a base cannot be safely advanced', () => {
    const base = buildReticulumChatAuthorTreeSnapshot(1144, [
      head('Qalice', 'a', 20),
      head('Qremoved', 'd', 4),
    ]);
    const target = buildReticulumChatAuthorTreeSnapshot(1144, [
      head('Qalice', 'a', 19),
    ]);

    const manifest = buildReticulumChatAuthorManifest(target, base);
    expect(manifest.full).toBe(true);
    expect(manifest.base).toBeUndefined();
    expect(materializeReticulumChatAuthorManifest(manifest)?.root).toBe(
      target.root
    );
  });

  it('rejects malformed manifests and deltas that do not prove the root', () => {
    const baseHeads = [head('Qalice', 'a', 8)];
    const base = buildReticulumChatAuthorTreeSnapshot(1144, baseHeads);
    const target = buildReticulumChatAuthorTreeSnapshot(1144, [
      head('Qalice', 'a', 9),
    ]);
    const manifest = buildReticulumChatAuthorManifest(target, base);
    manifest.heads[0][2] = 10;

    expect(
      materializeReticulumChatAuthorManifest(manifest, baseHeads)
    ).toBeNull();
    expect(
      parseReticulumChatAuthorManifest({
        ...manifest,
        heads: [manifest.heads[0], manifest.heads[0]],
      })
    ).toBeNull();
  });

  it('rejects a delta that regresses an append-only author stream', () => {
    const baseHeads = [head('Qalice', 'a', 8)];
    const target = buildReticulumChatAuthorTreeSnapshot(1144, [
      head('Qalice', 'a', 7),
    ]);

    expect(
      materializeReticulumChatAuthorManifest(
        {
          v: 1,
          g: 1144,
          root: target.root,
          base: buildReticulumChatAuthorTreeSnapshot(1144, baseHeads).root,
          full: false,
          count: 1,
          heads: [['Qalice', 'a'.repeat(32), 7]],
        },
        baseHeads
      )
    ).toBeNull();
  });
});
