import { describe, expect, it, vi } from 'vitest';
import { QAppPermissionBroker } from './qapp-permission-broker';

describe('Q-App permission broker', () => {
  it('accepts only the bound host main frame and only once', async () => {
    const deliver = vi.fn();
    const broker = new QAppPermissionBroker(deliver);
    const answer = broker.request(
      42,
      'Q-Tube',
      { text1: 'Publish?', sourceLabel: 'Hub', sourceKind: 'HUB' },
      'request-1'
    );
    const prompt = deliver.mock.calls[0][1];
    expect(prompt.payload.sourceLabel).toBe('Q-Tube');
    expect(prompt.payload.sourceKind).toBe('Q-APP');
    expect(broker.respond(prompt.promptId, 43, true, { accepted: true })).toBe(
      false
    );
    expect(broker.respond(prompt.promptId, 42, false, { accepted: true })).toBe(
      false
    );
    expect(
      broker.respond(prompt.promptId, 42, true, {
        accepted: true,
        checkbox1: true,
      })
    ).toBe(true);
    expect(await answer).toEqual({ accepted: true, checkbox1: true });
    expect(broker.respond(prompt.promptId, 42, true, { accepted: true })).toBe(
      false
    );
  });

  it('denies when the originating request or window closes', async () => {
    const deliver = vi.fn();
    const broker = new QAppPermissionBroker(deliver);
    const first = broker.request(42, 'Q-Tube', {}, 'request-1');
    const second = broker.request(43, 'Other', {}, 'request-2');
    broker.cancelRequest('request-1');
    broker.cancelHost(43);
    expect(await first).toEqual({ accepted: false });
    expect(await second).toEqual({ accepted: false });
  });

  it('denies a prompt that times out', async () => {
    vi.useFakeTimers();
    try {
      const broker = new QAppPermissionBroker(vi.fn(), 1000);
      const answer = broker.request(42, 'Q-Tube', {});
      await vi.advanceTimersByTimeAsync(1000);
      expect(await answer).toEqual({ accepted: false });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows one prompt per host and starts the next after an answer', async () => {
    const deliver = vi.fn();
    const broker = new QAppPermissionBroker(deliver);
    const first = broker.request(42, 'Q-Tube', { text1: 'First' });
    const second = broker.request(42, 'Q-Tube', { text1: 'Second' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(
      broker.respond(deliver.mock.calls[0][1].promptId, 42, true, {
        accepted: false,
      })
    ).toBe(true);
    expect(await first).toEqual({ accepted: false, checkbox1: false });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[1][1].payload.text1).toBe('Second');
    broker.respond(deliver.mock.calls[1][1].promptId, 42, true, {
      accepted: true,
    });
    expect(await second).toEqual({ accepted: true, checkbox1: false });
  });
});
