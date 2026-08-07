import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QortalLandRealtimeClient } from './qortalLandRealtime';

class MockWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  sent: unknown[] = [];
  closeCalls: Array<[number | undefined, string | undefined]> = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    MockWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new CloseEvent('close', { code: code ?? 1000, reason }));
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  receive(event: Record<string, unknown>): void {
    this.dispatchEvent(
      new MessageEvent('message', { data: JSON.stringify(event) })
    );
  }
}

describe('QortalLandRealtimeClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    Object.defineProperty(window, 'qortalLandRealtime', {
      configurable: true,
      value: {
        getTransportBootstrap: vi.fn().mockResolvedValue({
          url: 'ws://127.0.0.1:12345',
          token: 'token',
          instanceId: 'instance',
        }),
        onTransportRestarted: vi.fn(() => () => undefined),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'qortalLandRealtime', {
      configurable: true,
      value: undefined,
    });
  });

  it('replaces a socket that never reaches transport-ready', async () => {
    const client = new QortalLandRealtimeClient();
    const release = client.acquire();
    await vi.advanceTimersByTimeAsync(0);

    expect(MockWebSocket.instances).toHaveLength(1);
    const staleSocket = MockWebSocket.instances[0];
    staleSocket.open();

    await vi.advanceTimersByTimeAsync(5_250);

    expect(staleSocket.closeCalls).toEqual([
      [4001, 'transport readiness timed out'],
    ]);
    expect(MockWebSocket.instances).toHaveLength(2);
    release();
  });

  it('keeps a socket that authenticates and reaches transport-ready', async () => {
    const client = new QortalLandRealtimeClient();
    const states: boolean[] = [];
    const disposeState = client.onState((ready) => states.push(ready));
    const release = client.acquire();
    await vi.advanceTimersByTimeAsync(0);

    const socket = MockWebSocket.instances[0];
    socket.open();
    expect(JSON.parse(String(socket.sent[0]))).toEqual({
      type: 'AUTH',
      token: 'token',
      instanceId: 'instance',
    });
    socket.receive({ type: 'TRANSPORT_STATE', state: 'ready' });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.isReady()).toBe(true);
    expect(states).toEqual([false, true]);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(socket.closeCalls).toEqual([]);
    disposeState();
    release();
  });
});
