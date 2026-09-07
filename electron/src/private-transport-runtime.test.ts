import { describe, expect, it } from 'vitest';
import {
  getExperimentalPrivateTransportFactory,
  readTrustedRelayConfig,
} from './private-transport-runtime';

describe('private transport runtime selection', () => {
  it('uses Reticulum discovery without requiring test relay variables', () => {
    expect(
      getExperimentalPrivateTransportFactory({} as never, () => null, {
        QORTAL_PRIVATE_TRANSPORT: 'masque',
      })
    ).toBeTypeOf('function');
  });

  it('requires pinned relay values in explicit test mode', () => {
    expect(() =>
      getExperimentalPrivateTransportFactory({} as never, () => null, {
        QORTAL_PRIVATE_TRANSPORT: 'masque-test',
      })
    ).toThrow('Incomplete MASQUE prototype configuration');
  });

  it('parses the explicit test-mode relay boundary', () => {
    expect(
      readTrustedRelayConfig({
        QORTAL_MASQUE_TEST_RELAY_ADDRESS: '127.0.0.1:47322',
        QORTAL_MASQUE_TEST_RELAY_SERVER_NAME: 'relay.test',
        QORTAL_MASQUE_TEST_RELAY_CERT_SHA256: 'ab'.repeat(32),
      })
    ).toEqual({
      relayAddress: '127.0.0.1:47322',
      relayServerName: 'relay.test',
      relayCertSha256: 'ab'.repeat(32),
    });
  });
});
