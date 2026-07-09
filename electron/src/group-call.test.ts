import { describe, expect, it } from 'vitest';
import { reticulumAudioResetReasonForVerifiedJoin } from './group-call';

describe('group-call verified join audio reset decision', () => {
  it('keeps matching audio state when a fresh join arrives before roster catches up', () => {
    expect(
      reticulumAudioResetReasonForVerifiedJoin({
        existingReticulumDestinationHash: '',
        incomingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        currentAudioPeerPresenceHash: '4fe300e8dd1288580600a2c5f1952092',
        refreshedExistingJoin: false,
        rejoinsAfterLeave: false,
      })
    ).toBe('');
  });

  it('resets absent-participant audio state when it points at a different destination', () => {
    expect(
      reticulumAudioResetReasonForVerifiedJoin({
        existingReticulumDestinationHash: '',
        incomingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        currentAudioPeerPresenceHash: 'b0f911489514f8f4255e9207755e9157',
        refreshedExistingJoin: false,
        rejoinsAfterLeave: false,
      })
    ).toBe('join-identity-changed');
  });

  it('resets existing participant audio state on real identity changes', () => {
    expect(
      reticulumAudioResetReasonForVerifiedJoin({
        existingReticulumDestinationHash: 'b0f911489514f8f4255e9207755e9157',
        incomingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        currentAudioPeerPresenceHash: 'b0f911489514f8f4255e9207755e9157',
        refreshedExistingJoin: true,
        rejoinsAfterLeave: false,
      })
    ).toBe('join-identity-changed');
  });

  it('resets when a verified rejoin follows a real leave tombstone', () => {
    expect(
      reticulumAudioResetReasonForVerifiedJoin({
        existingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        incomingReticulumDestinationHash: '4fe300e8dd1288580600a2c5f1952092',
        currentAudioPeerPresenceHash: '4fe300e8dd1288580600a2c5f1952092',
        refreshedExistingJoin: true,
        rejoinsAfterLeave: true,
      })
    ).toBe('fresh-verified-rejoin-after-leave');
  });
});
