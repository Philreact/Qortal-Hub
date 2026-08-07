import { describe, expect, it } from 'vitest';
import { GroupCallAudioEngineRuntime } from './groupCallAudioEngineRuntime';

describe('group-call audio data-plane route ownership', () => {
  function runtime(): any {
    const instance = Object.create(
      GroupCallAudioEngineRuntime.prototype
    ) as any;
    instance.audioDataPlaneAddressesByPeerHash = new Map();
    instance.audioDataPlaneAddressesByLinkId = new Map();
    return instance;
  }

  const frame = (hash: string, linkId = 'shared-link') => ({
    linkId,
    peerPresenceHash: hash,
    peerDestinationHash: hash,
  });

  it('does not guess when one installation destination maps to two accounts', () => {
    const instance = runtime();
    const sharedHash = 'a'.repeat(32);

    instance.rememberAudioDataPlaneRoutes([
      {
        address: 'Q-old',
        linkId: 'shared-link',
        peerPresenceHash: sharedHash,
        peerDestinationHash: sharedHash,
      },
      {
        address: 'Q-new',
        linkId: 'shared-link',
        peerPresenceHash: sharedHash,
        peerDestinationHash: sharedHash,
      },
    ]);

    expect(instance.resolveAudioDataPlaneFrameAddress(frame(sharedHash))).toBe(
      ''
    );
  });

  it('replaces stale ownership when the bridge publishes a new route snapshot', () => {
    const instance = runtime();
    const sharedHash = 'b'.repeat(32);

    instance.rememberAudioDataPlaneRoutes([
      {
        address: 'Q-old',
        linkId: 'shared-link',
        peerPresenceHash: sharedHash,
        peerDestinationHash: sharedHash,
      },
    ]);
    expect(instance.resolveAudioDataPlaneFrameAddress(frame(sharedHash))).toBe(
      'Q-old'
    );

    instance.rememberAudioDataPlaneRoutes([
      {
        address: 'Q-new',
        linkId: 'shared-link',
        peerPresenceHash: sharedHash,
        peerDestinationHash: sharedHash,
      },
    ]);
    expect(instance.resolveAudioDataPlaneFrameAddress(frame(sharedHash))).toBe(
      'Q-new'
    );
  });

  it('uses an unambiguous authenticated link before an ambiguous device hash', () => {
    const instance = runtime();
    const sharedHash = 'c'.repeat(32);
    instance.rememberAudioDataPlaneRoutes([
      {
        address: 'Q-one',
        linkId: 'link-one',
        peerPresenceHash: sharedHash,
        peerDestinationHash: sharedHash,
      },
      {
        address: 'Q-two',
        linkId: 'link-two',
        peerPresenceHash: sharedHash,
        peerDestinationHash: sharedHash,
      },
    ]);

    expect(
      instance.resolveAudioDataPlaneFrameAddress(frame(sharedHash, 'link-one'))
    ).toBe('Q-one');
    expect(
      instance.resolveAudioDataPlaneFrameAddress(
        frame(sharedHash, 'unknown-link')
      )
    ).toBe('');
  });
});
