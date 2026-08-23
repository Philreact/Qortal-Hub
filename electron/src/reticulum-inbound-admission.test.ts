import { describe, expect, it } from 'vitest';
import { ReticulumInboundAdmissionController } from './reticulum-inbound-admission';

describe('ReticulumInboundAdmissionController', () => {
  it('shares an account allowance across devices while retaining device limits', () => {
    let now = 1_000;
    const controller = new ReticulumInboundAdmissionController(() => now);
    const base = {
      trafficClass: 'live-hint' as const,
      account: 'Q-account',
      scope: 'group:1144',
    };

    for (let index = 0; index < 24; index += 1) {
      expect(controller.admit({ ...base, device: 'device-a' }).allowed).toBe(
        true
      );
    }
    expect(controller.admit({ ...base, device: 'device-a' }).allowed).toBe(
      false
    );
    for (let index = 0; index < 8; index += 1) {
      expect(controller.admit({ ...base, device: 'device-b' }).allowed).toBe(
        true
      );
    }
    expect(controller.admit({ ...base, device: 'device-b' }).allowed).toBe(
      false
    );

    now += 1_000;
    expect(controller.admit({ ...base, device: 'device-a' }).allowed).toBe(
      true
    );
  });

  it('charges unsigned controls to the immediate admitted peer', () => {
    const controller = new ReticulumInboundAdmissionController(() => 5_000);
    let decision = controller.admit({
      trafficClass: 'sync',
      immediatePeer: 'relay-a',
      scope: 'group:716',
    });
    expect(decision.allowed).toBe(true);

    for (let index = 1; index < 40; index += 1) {
      decision = controller.admit({
        trafficClass: 'sync',
        immediatePeer: 'relay-a',
        scope: 'group:716',
      });
    }
    expect(decision.allowed).toBe(true);
    expect(
      controller.admit({
        trafficClass: 'sync',
        immediatePeer: 'relay-a',
        scope: 'group:716',
      })
    ).toMatchObject({ allowed: false, coalesce: true, reason: 'scope' });
  });

  it('does not consume tokens when a higher-level bucket denies work', () => {
    let now = 10_000;
    const controller = new ReticulumInboundAdmissionController(() => now);
    const input = {
      trafficClass: 'live-hint' as const,
      account: 'Q-account',
      device: 'device-a',
      scope: 'group:1143',
    };
    for (let index = 0; index < 24; index += 1) {
      expect(controller.admit(input).allowed).toBe(true);
    }
    expect(controller.admit(input).allowed).toBe(false);

    // A denied attempt does not consume the account/global buckets. Once the
    // device refill permits one frame, that frame is accepted immediately.
    now += 200;
    expect(controller.admit(input).allowed).toBe(true);
  });

  it('does not merge case-distinct Base58 account identities', () => {
    const controller = new ReticulumInboundAdmissionController(() => 20_000);

    for (let index = 0; index < 32; index += 1) {
      expect(
        controller.admit({
          trafficClass: 'live-hint',
          account: 'QaCaseSensitive',
          device: `device-${index}`,
        }).allowed
      ).toBe(true);
    }

    expect(
      controller.admit({
        trafficClass: 'live-hint',
        account: 'QaCaseSensitive',
        device: 'exhausted-account-device',
      }).allowed
    ).toBe(false);

    expect(
      controller.admit({
        trafficClass: 'live-hint',
        account: 'QACaseSensitive',
        device: 'another-device',
      }).allowed
    ).toBe(true);
  });

  it('cannot poison a bucket with a non-finite cost', () => {
    const controller = new ReticulumInboundAdmissionController(() => 30_000);
    expect(
      controller.admit({
        trafficClass: 'sync',
        immediatePeer: 'relay-a',
        cost: Number.NaN,
      }).allowed
    ).toBe(true);
    expect(
      controller.admit({
        trafficClass: 'sync',
        immediatePeer: 'relay-a',
      }).allowed
    ).toBe(true);
  });
});
