export type QortalLandRealtimeEvent = Record<string, unknown>;

type Listener = (event: QortalLandRealtimeEvent) => void;
type BinaryListener = (frame: ArrayBuffer) => void;
type StateListener = (ready: boolean) => void;

type BootstrapApi = {
  getTransportBootstrap: () => Promise<{
    url: string;
    token: string;
    instanceId: string;
  } | null>;
  onTransportRestarted: (callback: () => void) => () => void;
};

const reconnectDelays = [250, 500, 1_000, 2_000, 5_000];
const transportReadyTimeoutMs = 5_000;

export class QortalLandRealtimeClient {
  private socket: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private binaryListeners = new Set<BinaryListener>();
  private stateListeners = new Set<StateListener>();
  private restartDispose: (() => void) | null = null;
  private reconnectTimer: number | null = null;
  private readyTimer: number | null = null;
  private reconnectAttempt = 0;
  private connecting = false;
  private connectionEpoch = 0;
  private running = false;
  private ready = false;
  private instanceId = '';

  private api(): BootstrapApi | undefined {
    return window.qortalLandRealtime ?? window.qortalLandGames;
  }

  acquire(): () => void {
    this.running = true;
    if (!this.restartDispose) {
      this.restartDispose =
        this.api()?.onTransportRestarted(() => {
          this.connectionEpoch += 1;
          this.emitEvent({ type: 'TRANSPORT_RESTARTED' });
          this.setReady(false);
          this.reconnectAttempt = 0;
          this.clearReadyTimer();
          const socket = this.socket;
          this.socket = null;
          socket?.close();
          this.scheduleConnect(0);
        }) ?? null;
    }
    void this.connect();
    return () => {
      if (
        this.listeners.size ||
        this.binaryListeners.size ||
        this.stateListeners.size
      )
        return;
      this.running = false;
      this.connectionEpoch += 1;
      this.restartDispose?.();
      this.restartDispose = null;
      if (this.reconnectTimer !== null)
        window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.clearReadyTimer();
      const socket = this.socket;
      this.socket = null;
      socket?.close(1000, 'Qortal Land unmounted');
      this.setReady(false);
    };
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onBinary(listener: BinaryListener): () => void {
    this.binaryListeners.add(listener);
    return () => this.binaryListeners.delete(listener);
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    try {
      listener(this.ready);
    } catch (error) {
      console.warn('[QortalLandRealtime] initial state listener failed', error);
    }
    return () => this.stateListeners.delete(listener);
  }

  isReady(): boolean {
    return this.ready;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  send(command: Record<string, unknown>): void {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      !this.ready
    ) {
      throw new Error('Qortal Land realtime transport is unavailable');
    }
    this.socket.send(JSON.stringify(command));
  }

  sendBinary(frame: ArrayBuffer | Uint8Array): void {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN ||
      !this.ready
    ) {
      throw new Error('Qortal Land realtime transport is unavailable');
    }
    this.socket.send(frame);
  }

  private setReady(ready: boolean): void {
    if (this.ready === ready) return;
    this.ready = ready;
    for (const listener of this.stateListeners) {
      try {
        listener(ready);
      } catch (error) {
        console.warn('[QortalLandRealtime] state listener failed', error);
      }
    }
  }

  private emitEvent(event: QortalLandRealtimeEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[QortalLandRealtime] event listener failed', error);
      }
    }
  }

  private emitBinary(frame: ArrayBuffer): void {
    for (const listener of this.binaryListeners) {
      try {
        listener(frame);
      } catch (error) {
        console.warn('[QortalLandRealtime] binary listener failed', error);
      }
    }
  }

  private clearReadyTimer(): void {
    if (this.readyTimer === null) return;
    window.clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private abandonSocket(socket: WebSocket, reason: string): void {
    if (this.socket !== socket) return;
    this.clearReadyTimer();
    this.socket = null;
    this.setReady(false);
    console.warn(`[QortalLandRealtime] ${reason}; reconnecting`);
    try {
      socket.close(4001, reason);
    } catch {
      // The stale socket is already detached from the client.
    }
    this.scheduleConnect();
  }

  private armReadyTimer(socket: WebSocket): void {
    this.clearReadyTimer();
    this.readyTimer = window.setTimeout(() => {
      this.readyTimer = null;
      if (this.socket !== socket || this.ready) return;
      this.abandonSocket(socket, 'transport readiness timed out');
    }, transportReadyTimeoutMs);
  }

  private scheduleConnect(delay?: number): void {
    if (!this.running || this.reconnectTimer !== null) return;
    const retryDelay =
      delay ??
      reconnectDelays[
        Math.min(this.reconnectAttempt, reconnectDelays.length - 1)
      ];
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, retryDelay);
  }

  private async connect(): Promise<void> {
    if (!this.running || this.socket || this.connecting) return;
    const api = this.api();
    if (!api) return;
    const epoch = this.connectionEpoch;
    this.connecting = true;
    let bootstrap: Awaited<ReturnType<BootstrapApi['getTransportBootstrap']>> =
      null;
    try {
      bootstrap = await api.getTransportBootstrap();
    } catch {
      // Python may still be starting.
    }
    this.connecting = false;
    if (!this.running || epoch !== this.connectionEpoch) {
      if (this.running) this.scheduleConnect(0);
      return;
    }
    if (!bootstrap) {
      this.scheduleConnect();
      return;
    }
    let socket: WebSocket;
    try {
      socket = new WebSocket(bootstrap.url);
    } catch {
      this.scheduleConnect();
      return;
    }
    this.instanceId = bootstrap.instanceId;
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.armReadyTimer(socket);
    socket.addEventListener('open', () => {
      if (this.socket !== socket || !this.running) return socket.close();
      try {
        socket.send(
          JSON.stringify({
            type: 'AUTH',
            token: bootstrap?.token,
            instanceId: bootstrap?.instanceId,
          })
        );
      } catch {
        this.abandonSocket(socket, 'transport authentication send failed');
      }
    });
    socket.addEventListener('message', (message) => {
      if (this.socket !== socket) return;
      if (message.data instanceof ArrayBuffer) {
        this.emitBinary(message.data);
        return;
      }
      let event: QortalLandRealtimeEvent;
      try {
        const parsed = JSON.parse(String(message.data));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          return;
        event = parsed as QortalLandRealtimeEvent;
      } catch {
        return;
      }
      if (event.type === 'TRANSPORT_STATE') {
        const nextReady = event.state === 'ready';
        this.setReady(nextReady);
        if (nextReady) {
          this.clearReadyTimer();
          this.reconnectAttempt = 0;
        }
      }
      this.emitEvent(event);
    });
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.clearReadyTimer();
      this.socket = null;
      this.setReady(false);
      this.scheduleConnect();
    });
    socket.addEventListener('error', () => {
      this.abandonSocket(socket, 'transport socket failed');
    });
  }
}

export const qortalLandRealtime = new QortalLandRealtimeClient();
