import { describe, expect, it, vi } from 'vitest';
import {
  QAppReticulumError,
  QAppReticulumManager,
  type QAppReticulumNativeEvent,
  type QAppReticulumOwner,
  type QAppReticulumTransport,
} from './qapp-reticulum-manager';
import vectors from '../../protocol-v1-vectors.json';

class FakeTransport implements QAppReticulumTransport {
  listeners = new Set<(event: QAppReticulumNativeEvent) => void>();
  invoke = vi.fn(async (action: string, payload: Record<string, unknown>) => ({
    ok: true,
    payload:
      action === 'qapp_rns_request'
        ? {
            payloadBase64: Buffer.from(JSON.stringify({ ok: true })).toString(
              'base64'
            ),
            encoding: 'json',
          }
        : { messageId: '1', ...payload },
  }));
  onEvent(listener: (event: QAppReticulumNativeEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const destination = '0123456789abcdef0123456789abcdef';
const alice: QAppReticulumOwner = {
  tabId: '1',
  name: 'Alice App',
  service: 'APP',
};
const bob: QAppReticulumOwner = {
  tabId: '2',
  name: 'Bob App',
  service: 'APP',
};

describe('QAppReticulumManager', () => {
  it('uses the same isolated manager key for RPC and realtime', async () => {
    const transport = new FakeTransport();
    const manager = new QAppReticulumManager(transport);
    await manager.connect(alice, destination);
    await manager.request(alice, { destination, path: '/hello', payload: {} });
    const connectPayload = transport.invoke.mock.calls[0][1];
    const requestPayload = transport.invoke.mock.calls[1][1];
    expect(connectPayload.managerKey).toBe(requestPayload.managerKey);
  });

  it('encodes the frozen RPC request payload and decodes its JSON response', async () => {
    const transport = new FakeTransport();
    const manager = new QAppReticulumManager(transport);
    const response = await manager.request(alice, {
      destination,
      path: '/hello',
      payload: vectors.rpc_request.application_json,
      requestId: vectors.rpc_request.request_id,
    });
    const request = transport.invoke.mock.calls[0][1];
    expect(request).toMatchObject({
      path: '/hello',
      requestId: vectors.rpc_request.request_id,
      encoding: 'json',
      payloadBase64: vectors.rpc_request.payload_base64,
    });
    expect(response).toEqual({ ok: true });
  });

  it('encodes RNS_SEND JSON and decodes RNS_MESSAGE JSON symmetrically', async () => {
    const transport = new FakeTransport();
    const manager = new QAppReticulumManager(transport);
    const listener = vi.fn();
    manager.on('event', listener);
    const connection = await manager.connect(alice, destination);
    await manager.send(
      alice,
      connection.connectionId,
      vectors.data_envelope.application_json
    );
    const sendPayload = transport.invoke.mock.calls[1][1];
    expect(sendPayload).toMatchObject({
      encoding: 'json',
      payloadBase64: vectors.data_envelope.payload_base64,
    });
    const managerKey = transport.invoke.mock.calls[0][1].managerKey as string;
    for (const callback of transport.listeners) {
      callback({
        managerKey,
        connectionId: connection.connectionId,
        kind: 'message',
        encoding: 'json',
        payloadBase64: vectors.data_envelope.payload_base64,
      });
    }
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RNS_MESSAGE',
        payload: vectors.data_envelope.application_json,
      })
    );
  });

  it('delivers a zero-length binary RNS_MESSAGE', async () => {
    const transport = new FakeTransport();
    const manager = new QAppReticulumManager(transport);
    const listener = vi.fn();
    manager.on('event', listener);
    const connection = await manager.connect(alice, destination);
    const managerKey = transport.invoke.mock.calls[0][1].managerKey as string;
    for (const callback of transport.listeners) {
      callback({
        managerKey,
        connectionId: connection.connectionId,
        kind: 'message',
        encoding: 'base64',
        payloadBase64: '',
      });
    }
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RNS_MESSAGE',
        payload: new Uint8Array(0),
      })
    );
  });

  it('rejects cross-Q-App send and close attempts', async () => {
    const manager = new QAppReticulumManager(new FakeTransport());
    const { connectionId } = await manager.connect(alice, destination);
    await expect(manager.send(bob, connectionId, {})).rejects.toMatchObject({
      code: 'RNS_INVALID_CONNECTION',
    });
    await expect(manager.close(bob, connectionId)).rejects.toBeInstanceOf(
      QAppReticulumError
    );
  });

  it('cleans every logical connection owned by a destroyed tab', async () => {
    const transport = new FakeTransport();
    const manager = new QAppReticulumManager(transport);
    await manager.connect(alice, destination);
    await manager.connect(alice, destination);
    await manager.cleanupOwner(alice);
    expect(
      transport.invoke.mock.calls.filter(
        ([action]) => action === 'qapp_rns_close'
      )
    ).toHaveLength(2);
  });

  it('drops native events whose manager ownership does not match', async () => {
    const transport = new FakeTransport();
    const manager = new QAppReticulumManager(transport);
    const listener = vi.fn();
    manager.on('event', listener);
    const connection = await manager.connect(alice, destination);
    for (const callback of transport.listeners) {
      callback({
        managerKey: 'attacker',
        connectionId: connection.connectionId,
        kind: 'message',
        payloadBase64: Buffer.from('{}').toString('base64'),
        encoding: 'json',
      });
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not resurrect a connection closed while native events are pending', async () => {
    const transport = new FakeTransport();
    const manager = new QAppReticulumManager(transport);
    const listener = vi.fn();
    manager.on('event', listener);
    const connection = await manager.connect(alice, destination);
    const managerKey = transport.invoke.mock.calls[0][1].managerKey as string;
    await manager.close(alice, connection.connectionId);
    for (const callback of transport.listeners) {
      callback({
        managerKey,
        connectionId: connection.connectionId,
        kind: 'state',
        state: 'CONNECTED',
      });
    }
    expect(listener.mock.calls.map(([event]) => event.state)).toEqual([
      'CLOSING',
      'CLOSED',
    ]);
    await expect(
      manager.send(alice, connection.connectionId, {})
    ).rejects.toMatchObject({ code: 'RNS_INVALID_CONNECTION' });
  });

  it('rejects a raw payload whose Base64 DATA envelope exceeds the frame limit', async () => {
    const manager = new QAppReticulumManager(new FakeTransport());
    const connection = await manager.connect(alice, destination);
    await expect(
      manager.send(alice, connection.connectionId, new Uint8Array(256 * 1024))
    ).rejects.toMatchObject({ code: 'RNS_MESSAGE_TOO_LARGE' });
  });

  it('does not automatically replay an ambiguously failed RPC', async () => {
    const transport = new FakeTransport();
    transport.invoke = vi.fn(async () => ({
      ok: false,
      code: 'RNS_REQUEST_TIMEOUT',
    }));
    const manager = new QAppReticulumManager(transport);
    await expect(
      manager.request(alice, {
        destination,
        path: '/create-item',
        payload: { value: 1 },
        requestId: 'operation-1',
      })
    ).rejects.toMatchObject({ code: 'RNS_REQUEST_TIMEOUT' });
    expect(transport.invoke).toHaveBeenCalledTimes(1);
  });
});
