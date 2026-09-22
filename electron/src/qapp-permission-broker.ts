import { randomUUID } from 'crypto';

export type QAppPermissionAnswer = { accepted: boolean; checkbox1?: boolean };
export type QAppPermissionPrompt = {
  promptId: string;
  appName: string;
  payload: Record<string, unknown>;
};

type Pending = {
  hostId: number;
  appName: string;
  payload: Record<string, unknown>;
  requestId?: string;
  resolve: (answer: QAppPermissionAnswer) => void;
  timer?: NodeJS.Timeout;
  delivered: boolean;
};

const DENIED = { accepted: false };

export class QAppPermissionBroker {
  private pending = new Map<string, Pending>();

  constructor(
    private deliver: (hostId: number, prompt: QAppPermissionPrompt) => void,
    private timeoutMs = 60_000,
    private dismiss?: (hostId: number, promptId: string) => void
  ) {}

  request(
    hostId: number,
    appName: string,
    payload: Record<string, unknown>,
    requestId?: string
  ): Promise<QAppPermissionAnswer> {
    if (this.pending.size >= 64) return Promise.resolve(DENIED);
    const promptId = randomUUID();
    return new Promise((resolve) => {
      this.pending.set(promptId, {
        hostId,
        appName,
        payload,
        requestId,
        resolve,
        delivered: false,
      });
      this.showNext(hostId);
    });
  }

  respond(
    promptId: unknown,
    senderId: number,
    isMainFrame: boolean,
    answer: unknown
  ): boolean {
    if (typeof promptId !== 'string' || !isMainFrame) return false;
    const pending = this.pending.get(promptId);
    if (!pending || !pending.delivered || pending.hostId !== senderId)
      return false;
    const value =
      answer && typeof answer === 'object'
        ? (answer as Record<string, unknown>)
        : {};
    this.finish(promptId, {
      accepted: value.accepted === true,
      checkbox1: value.checkbox1 === true,
    });
    return true;
  }

  cancelHost(hostId: number): void {
    for (const [id, pending] of this.pending) {
      if (pending.hostId === hostId) this.finish(id, DENIED);
    }
  }

  cancelRequest(requestId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.requestId === requestId) this.finish(id, DENIED);
    }
  }

  private finish(id: string, answer: QAppPermissionAnswer): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.delivered) {
      try {
        this.dismiss?.(pending.hostId, id);
      } catch {
        // A closing host must not leave the permission promise unresolved.
      }
    }
    pending.resolve(answer);
    this.showNext(pending.hostId);
  }

  private showNext(hostId: number): void {
    if (
      [...this.pending.values()].some(
        (value) => value.hostId === hostId && value.delivered
      )
    )
      return;
    const next = [...this.pending.entries()].find(
      ([, value]) => value.hostId === hostId && !value.delivered
    );
    if (!next) return;
    const [promptId, pending] = next;
    pending.delivered = true;
    pending.timer = setTimeout(
      () => this.finish(promptId, DENIED),
      this.timeoutMs
    );
    try {
      this.deliver(hostId, {
        promptId,
        appName: pending.appName,
        payload: {
          ...pending.payload,
          appName: pending.appName,
          sourceKind: 'Q-APP',
          sourceLabel: pending.appName,
        },
      });
    } catch {
      this.finish(promptId, DENIED);
    }
  }
}
