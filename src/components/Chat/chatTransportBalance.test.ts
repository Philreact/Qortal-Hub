import { describe, expect, it } from 'vitest';
import { shouldBlockChatForLowBalance } from './chatTransportBalance';

describe('shouldBlockChatForLowBalance', () => {
  it('does not require a QORT balance for Reticulum chat', () => {
    expect(shouldBlockChatForLowBalance(0, 4, true)).toBe(false);
  });

  it('keeps the minimum balance requirement for legacy Q-Chat', () => {
    expect(shouldBlockChatForLowBalance(0, 4, false)).toBe(true);
    expect(shouldBlockChatForLowBalance(4, 4, false)).toBe(false);
  });
});
