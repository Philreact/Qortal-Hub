import { describe, expect, it, vi } from 'vitest';
import {
  invokeGroupCallJoin,
  type GroupCallJoinIpcArguments,
} from './group-call-ipc-contract';

describe('group-call join IPC contract', () => {
  it('forwards takeover and pinned DM route arguments from every renderer', async () => {
    const invoke = vi.fn(async () => ({ success: true }));
    const args: GroupCallJoinIpcArguments = [
      'gcall-qortal-1143',
      'group:1143',
      'Q-local',
      'signature',
      'public-key',
      1234,
      'a'.repeat(32),
      42,
      7,
      'identity-key',
      'identity-signature',
      'opener',
      true,
      'b'.repeat(32),
      'call-id',
    ];

    await invokeGroupCallJoin(invoke, ...args);

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('gcall:join', ...args);
  });
});
