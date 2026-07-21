import { describe, expect, it } from 'vitest';
import { canSignQortalLandGameHandshake } from './useQortalLandGame';

const match = {
  matchId: '00112233-4455-6677-8899-aabbccddeeff',
  requesterAddress: 'Q-requester',
  recipientAddress: 'Q-recipient',
  requesterNonce: '11'.repeat(16),
  phase: 'opening' as const,
};

describe('Qortal Land game handshake signing guard', () => {
  it('allows the locally challenged outgoing invitation', () => {
    expect(canSignQortalLandGameHandshake({
      type: 'QORTAL_LAND_GAME_INVITE',
      matchId: match.matchId,
      requesterAddress: match.requesterAddress,
      recipientAddress: match.recipientAddress,
      signerPublicKey: 'public-key',
      requesterNonce: match.requesterNonce,
      protocolVersion: 1,
      game: 'connect-four',
      gameVersion: 1,
      rulesVersion: 1,
    }, match, match.requesterAddress, 'public-key')).toBe(true);
  });

  it('rejects a changed match, recipient, or signer key', () => {
    const fields = {
      type: 'QORTAL_LAND_GAME_INVITE',
      matchId: match.matchId,
      requesterAddress: match.requesterAddress,
      recipientAddress: match.recipientAddress,
      signerPublicKey: 'public-key',
      requesterNonce: match.requesterNonce,
      protocolVersion: 1,
      game: 'connect-four',
      gameVersion: 1,
      rulesVersion: 1,
    };
    expect(canSignQortalLandGameHandshake({ ...fields, matchId: 'other' }, match, match.requesterAddress, 'public-key')).toBe(false);
    expect(canSignQortalLandGameHandshake({ ...fields, recipientAddress: 'Q-other' }, match, match.requesterAddress, 'public-key')).toBe(false);
    expect(canSignQortalLandGameHandshake({ ...fields, signerPublicKey: 'other' }, match, match.requesterAddress, 'public-key')).toBe(false);
  });

  it('allows only local busy/superseded declines without replacing the active match', () => {
    expect(canSignQortalLandGameHandshake({
      type: 'QORTAL_LAND_GAME_DECLINE',
      matchId: 'crossed-match',
      responderAddress: match.requesterAddress,
      signerPublicKey: 'public-key',
      reason: 'busy',
    }, match, match.requesterAddress, 'public-key')).toBe(true);
    expect(canSignQortalLandGameHandshake({
      type: 'QORTAL_LAND_GAME_DECLINE',
      matchId: 'crossed-match',
      responderAddress: 'Q-other',
      signerPublicKey: 'public-key',
      reason: 'busy',
    }, match, match.requesterAddress, 'public-key')).toBe(false);
  });
});
