import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { PrivateChannelBootstrapProvider } from './private-channel-bootstrap';
import {
  PrivateTransportSidecarError,
  type PrivateSessionConfig,
} from './private-transport-sidecar';
import { QuicMasqueTransport } from './quic-masque-transport';

class SidecarStub extends EventEmitter {
  attempts: PrivateSessionConfig[] = [];

  async openPrivateSession(config: PrivateSessionConfig) {
    this.attempts.push(config);
    if (this.attempts.length === 1) {
      throw new PrivateTransportSidecarError('MASQUE_TUNNEL_FAILED');
    }
    return { sessionId: 'local-session' };
  }
}

describe('QUIC MASQUE transport', () => {
  it('falls back to the pinned same-host relay when public NAT hairpinning fails', async () => {
    const sidecar = new SidecarStub();
    const bootstrapProvider: PrivateChannelBootstrapProvider = {
      getBootstrap: vi.fn(async () => ({
        backendRnsDestination: 'ab'.repeat(16),
        backendTransportEndpoint: '127.0.0.1:4445',
        backendTransportServerName: 'backend.test',
        backendTransportCertSha256: 'cd'.repeat(32),
        logicalSessionId: 'logical-session',
        attachToken: 'attach-token',
        nonce: 'n'.repeat(32),
        ownerBindingHash: 'ef'.repeat(32),
        expiresAt: Date.now() + 10_000,
      })),
    };
    const transport = new QuicMasqueTransport(
      vi.fn(),
      sidecar as never,
      {
        relayAddress: '8.8.8.8:47322',
        relayServerName: 'relay.test',
        relayCertSha256: '12'.repeat(32),
        localFallbackAddress: '127.0.0.1:47322',
      },
      bootstrapProvider
    );

    await transport.open({
      owner: { tabId: 'tab', name: 'qapp-ui-call', service: 'APP' },
      rnsConnectionId: 'rns-connection',
      purpose: 'realtime',
    });

    expect(sidecar.attempts.map((attempt) => attempt.relayAddress)).toEqual([
      '8.8.8.8:47322',
      '127.0.0.1:47322',
    ]);
  });
});
