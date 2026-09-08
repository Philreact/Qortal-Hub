import { describe, expect, it, vi } from 'vitest';
import {
  QAppMoqTransportManager,
  type ManagedMoqTransport,
} from './moq-transport-manager';
import type { MoqTransportEvent } from './moq-masque-transport';

const owner = { tabId: 'tab-1', name: 'call-app', service: 'APP' };

class FakeTransport implements ManagedMoqTransport {
  open = vi.fn(async () => undefined);
  subscribe = vi.fn(async () => undefined);
  publish = vi.fn(async () => undefined);
  metrics = vi.fn(async () => ({ objectsSent: 1 }));
  close = vi.fn(async () => undefined);

  constructor(readonly emit: (event: MoqTransportEvent) => void) {}
}

function setup(ownership: 'owned' | 'missing' | 'not-owned' = 'owned') {
  const transports: FakeTransport[] = [];
  const manager = new QAppMoqTransportManager(
    () => ownership,
    (emit) => {
      const transport = new FakeTransport(emit);
      transports.push(transport);
      return transport;
    }
  );
  const events: unknown[] = [];
  manager.on('event', (event) => events.push(event));
  return { manager, transports, events };
}

async function open(manager: QAppMoqTransportManager) {
  return manager.open(
    owner,
    'rns-1',
    ['qortal', 'call', 'room-123', 'QAlice123'],
    'audio'
  );
}

describe('Q-App generic MOQT manager', () => {
  it('binds a session to the Q-App-owned Reticulum connection', async () => {
    const { manager, transports } = setup();
    const opened = await open(manager);
    expect(opened.state).toBe('OPEN');
    expect(transports[0].open).toHaveBeenCalledWith({
      owner,
      rnsConnectionId: 'rns-1',
      publicationNamespace: ['qortal', 'call', 'room-123', 'QAlice123'],
      publicationTrack: 'audio',
    });

    const missing = setup('missing');
    await expect(open(missing.manager)).rejects.toMatchObject({
      code: 'INVALID_RNS_CONNECTION',
    });
  });

  it('subscribes and carries only bounded opaque binary objects', async () => {
    const { manager, transports, events } = setup();
    const opened = await open(manager);
    await manager.subscribe(
      owner,
      opened.sessionId,
      'peer-QBob456',
      ['qortal', 'call', 'room-123', 'QBob456'],
      'audio'
    );
    await manager.publish(owner, opened.sessionId, new Uint8Array([1, 2, 3]));
    expect(transports[0].publish).toHaveBeenCalledWith(
      new Uint8Array([1, 2, 3])
    );

    transports[0].emit({
      kind: 'object',
      subscriptionId: 'peer-QBob456',
      namespace: ['qortal', 'call', 'room-123', 'QBob456'],
      trackName: 'audio',
      groupId: 0,
      objectId: 1,
      payload: new Uint8Array([7, 8]),
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        action: 'MOQ_OBJECT',
        sessionId: opened.sessionId,
        payload: new Uint8Array([7, 8]),
      })
    );
    await expect(
      manager.publish(owner, opened.sessionId, new Uint8Array(1025))
    ).rejects.toMatchObject({ code: 'MOQ_OBJECT_TOO_LARGE' });
  });

  it('isolates owners and closes sessions with their Reticulum connection', async () => {
    const { manager, transports } = setup();
    const opened = await open(manager);
    await expect(
      manager.metrics({ ...owner, tabId: 'other-tab' }, opened.sessionId)
    ).rejects.toMatchObject({ code: 'MOQ_SESSION_NOT_OWNED' });
    await manager.cleanupRnsConnection(owner, 'rns-1');
    expect(transports[0].close).toHaveBeenCalledOnce();
    await expect(
      manager.metrics(owner, opened.sessionId)
    ).rejects.toMatchObject({ code: 'MOQ_SESSION_CLOSED' });
  });
});
