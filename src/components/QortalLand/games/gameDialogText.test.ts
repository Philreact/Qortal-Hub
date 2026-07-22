import { describe, expect, it } from 'vitest';

import { friendlyGameStatus } from './gameDialogText';

describe('friendlyGameStatus', () => {
  it('turns rematch declines into natural copy', () => {
    expect(friendlyGameStatus('Rematch declined')).toBe('Rematching was declined.');
  });

  it('hides internal busy error names', () => {
    expect(friendlyGameStatus('game_busy')).toBe('The other player is currently busy.');
    expect(friendlyGameStatus('Invitation busy')).toBe('The other player is currently busy.');
  });

  it('humanizes an unknown internal status', () => {
    expect(friendlyGameStatus('connection_lost')).toBe('Connection lost.');
  });
});
