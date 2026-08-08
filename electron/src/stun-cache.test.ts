import { describe, expect, it } from 'vitest';
import {
  isEligibleStunEndpointRow,
  STUN_PROBE_FRESHNESS_MS,
  type StunEndpointRow,
} from './stun-cache';

function row(overrides: Partial<StunEndpointRow> = {}): StunEndpointRow {
  return {
    stun_key: '203.0.113.10:47321',
    host: '203.0.113.10',
    stun_port: 47321,
    probe_success_at: null,
    probe_fail_at: null,
    probe_rtt_ewma: null,
    probe_fail_streak: 0,
    call_success_events: 0,
    call_fail_events: 0,
    observer_confirmations: 0,
    stun_server_capable: 0,
    updated_at: 0,
    ...overrides,
  };
}

describe('community STUN cache eligibility', () => {
  const now = 2_000_000_000_000;

  it('requires a recent successful local probe', () => {
    expect(isEligibleStunEndpointRow(row(), now)).toBe(false);
    expect(
      isEligibleStunEndpointRow(
        row({ stun_server_capable: 1, probe_success_at: now - 1_000 }),
        now
      )
    ).toBe(true);
    expect(
      isEligibleStunEndpointRow(
        row({
          stun_server_capable: 1,
          probe_success_at: now - STUN_PROBE_FRESHNESS_MS - 1,
        }),
        now
      )
    ).toBe(false);
  });

  it('rejects an endpoint after a newer failed probe', () => {
    expect(
      isEligibleStunEndpointRow(
        row({
          stun_server_capable: 1,
          probe_success_at: now - 2_000,
          probe_fail_at: now - 1_000,
        }),
        now
      )
    ).toBe(false);
  });
});
