import { describe, expect, it } from 'vitest';
import {
  isEligibleStunEndpointRow,
  selectStunReprobeCandidates,
  STUN_PROBE_FAILURE_THRESHOLD,
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

  it('tolerates one lost probe but rejects repeated newer failures', () => {
    expect(
      isEligibleStunEndpointRow(
        row({
          stun_server_capable: 1,
          probe_success_at: now - 2_000,
          probe_fail_at: now - 1_000,
          probe_fail_streak: STUN_PROBE_FAILURE_THRESHOLD - 1,
        }),
        now
      )
    ).toBe(true);
    expect(
      isEligibleStunEndpointRow(
        row({
          stun_server_capable: 1,
          probe_success_at: now - 2_000,
          probe_fail_at: now - 1_000,
          probe_fail_streak: STUN_PROBE_FAILURE_THRESHOLD,
        }),
        now
      )
    ).toBe(false);
  });
});

describe('community STUN cached re-probe candidates', () => {
  it('returns only previously verified endpoints which are due', () => {
    const now = Date.now();
    const verified = row({
      stun_key: '8.8.8.8:47321',
      host: '8.8.8.8',
      stun_port: 47321,
      stun_server_capable: 1,
      probe_success_at: now,
    });
    const neverVerified = row({
      stun_key: '1.1.1.1:47321',
      host: '1.1.1.1',
      stun_port: 47321,
      probe_fail_at: now,
    });

    expect(
      selectStunReprobeCandidates(
        [verified, neverVerified],
        6,
        {
          now: now + 5 * 60_000,
          maxSuccessAgeMs: 24 * 60 * 60_000,
          minAttemptAgeMs: 4 * 60_000,
        },
        () => 1
      )
    ).toEqual([expect.objectContaining({ host: '8.8.8.8', stunPort: 47321 })]);
    expect(
      selectStunReprobeCandidates(
        [verified],
        6,
        {
          now: now + 60_000,
          maxSuccessAgeMs: 24 * 60 * 60_000,
          minAttemptAgeMs: 4 * 60_000,
        },
        () => 1
      )
    ).toEqual([]);
  });

  it('does not resurrect endpoints whose last verification is too old', () => {
    const now = Date.now();
    expect(
      selectStunReprobeCandidates(
        [
          row({
            stun_key: '8.8.4.4:47321',
            host: '8.8.4.4',
            stun_port: 47321,
            stun_server_capable: 1,
            probe_success_at: now,
          }),
        ],
        6,
        {
          now: Date.now() + 25 * 60 * 60_000,
          maxSuccessAgeMs: 24 * 60 * 60_000,
          minAttemptAgeMs: 0,
        },
        () => 1
      )
    ).toEqual([]);
  });
});
