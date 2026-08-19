import { describe, expect, it } from 'vitest';
import {
  GroupCallSilenceGate,
  GROUP_CALL_SILENCE_HANGOVER_MS,
} from './groupCallSilenceGate';

const frame = (capturePerfMs: number, vad: boolean, id = capturePerfMs) => ({
  opusFrame: Uint8Array.of(id & 0xff),
  vad,
  capturePerfMs,
  encoderInputPerfMs: capturePerfMs + 1,
  encodeOutPerfMs: capturePerfMs + 2,
  pipelineGeneration: 'test:1',
});

describe('GroupCallSilenceGate', () => {
  it('fails open until VAD has positively identified speech', () => {
    const gate = new GroupCallSilenceGate();
    gate.reset({ initialOpen: true, nowPerfMs: 0 });
    expect(gate.process(frame(0, false), 100).framesToTransmit).toHaveLength(1);
    expect(
      gate.process(frame(GROUP_CALL_SILENCE_HANGOVER_MS + 20, false), 100)
        .framesToTransmit
    ).toHaveLength(1);
    expect(
      gate.getDiagnostics(GROUP_CALL_SILENCE_HANGOVER_MS + 20)
        .speechDetectionProven
    ).toBe(false);
  });

  it('keeps startup open for 600 ms after proven speech, then suppresses silence', () => {
    const gate = new GroupCallSilenceGate();
    gate.reset({ initialOpen: true, nowPerfMs: 0 });
    expect(gate.process(frame(0, true), 100).framesToTransmit).toHaveLength(1);
    expect(
      gate.process(frame(GROUP_CALL_SILENCE_HANGOVER_MS, false), 100)
        .framesToTransmit
    ).toHaveLength(1);
    const suppressed = gate.process(
      frame(GROUP_CALL_SILENCE_HANGOVER_MS + 20, false),
      100
    );
    expect(suppressed.framesToTransmit).toHaveLength(0);
    expect(suppressed.enteredSilence).toBe(true);
  });

  it('keeps transmitting through short pauses and VAD flicker', () => {
    const gate = new GroupCallSilenceGate();
    gate.reset({ initialOpen: false });
    expect(gate.process(frame(100, true), 100).framesToTransmit).toHaveLength(
      1
    );
    expect(gate.process(frame(680, false), 100).framesToTransmit).toHaveLength(
      1
    );
    expect(gate.process(frame(700, true), 100).framesToTransmit).toHaveLength(
      1
    );
    expect(
      gate.process(frame(1_280, false), 100).framesToTransmit
    ).toHaveLength(1);
  });

  it('flushes exactly 120 ms of fresh pre-roll oldest-first', () => {
    const gate = new GroupCallSilenceGate();
    gate.reset({ initialOpen: false });
    gate.process(frame(-620, true), 100);
    for (let time = 0; time <= 180; time += 20) {
      gate.process(frame(time, false, time / 20), 100);
    }
    const decision = gate.process(frame(200, true, 99), 100);
    expect(decision.framesToTransmit.map((item) => item.opusFrame[0])).toEqual([
      4, 5, 6, 7, 8, 9, 99,
    ]);
    expect(decision.exitedSilence).toBe(true);
    expect(gate.getDiagnostics(200).preRollFrames).toBe(6);
  });

  it('never flushes stale pre-roll after sleep or an encoder stall', () => {
    const gate = new GroupCallSilenceGate();
    gate.reset({ initialOpen: false });
    gate.process(frame(-620, true), 100);
    gate.process(frame(0, false, 1), 100);
    gate.process(frame(20, false, 2), 100);
    const decision = gate.process(frame(10_000, true, 3), 100);
    expect(decision.framesToTransmit.map((item) => item.opusFrame[0])).toEqual([
      3,
    ]);
    expect(decision.discardedStalePreRollFrames).toBe(0);
    expect(
      gate.process(frame(10_020, false, 4), 100).framesToTransmit
    ).toHaveLength(1);
  });

  it('discards buffered frames on mute, device, session, or teardown reset', () => {
    const gate = new GroupCallSilenceGate();
    gate.reset({ initialOpen: false });
    gate.process(frame(-620, true), 100);
    gate.process(frame(0, false), 100);
    gate.reset({ initialOpen: true, nowPerfMs: 1_000 });
    expect(gate.process(frame(1_000, true, 7), 100).framesToTransmit).toEqual([
      frame(1_000, true, 7),
    ]);
    expect(gate.getDiagnostics(1_000).estimatedBytesSaved).toBe(100);
  });

  it('reports at least 80% suppression during sustained silence', () => {
    const gate = new GroupCallSilenceGate();
    gate.reset({ initialOpen: true, nowPerfMs: 0 });
    gate.process(frame(0, true), 100);
    for (let time = 0; time < 10_000; time += 20) {
      gate.process(frame(time, false), 100);
    }
    const diagnostics = gate.getDiagnostics(10_000);
    expect(diagnostics.suppressedFrames / 500).toBeGreaterThan(0.8);
    expect(diagnostics.bufferedPreRollFrames).toBe(6);
  });

  it('keeps transmitted sequences contiguous and capture timestamps monotonic', () => {
    const gate = new GroupCallSilenceGate();
    gate.reset({ initialOpen: true, nowPerfMs: 0 });
    const transmitted: Array<{ sequence: number; timestamp: number }> = [];
    let sequence = 0;
    for (let time = 0; time <= 2_000; time += 20) {
      const speaking = time < 200 || time >= 1_800;
      for (const item of gate.process(frame(time, speaking), 100)
        .framesToTransmit) {
        transmitted.push({
          sequence: sequence++,
          timestamp: item.capturePerfMs,
        });
      }
    }
    expect(transmitted.map((item) => item.sequence)).toEqual(
      transmitted.map((_, index) => index)
    );
    expect(
      transmitted.every(
        (item, index) =>
          index === 0 || item.timestamp > transmitted[index - 1]!.timestamp
      )
    ).toBe(true);
    expect(transmitted.some((item) => item.timestamp === 1_680)).toBe(true);
  });

  it('remains bounded through a 30-minute silence-to-speech simulation', () => {
    const gate = new GroupCallSilenceGate();
    gate.reset({ initialOpen: true, nowPerfMs: 0 });
    for (let time = 0; time < 30 * 60_000; time += 20) {
      const withinCycle = time % 10_000;
      gate.process(frame(time, withinCycle >= 8_000), 100);
      expect(
        gate.getDiagnostics(time).bufferedPreRollFrames
      ).toBeLessThanOrEqual(6);
    }
    const diagnostics = gate.getDiagnostics(30 * 60_000);
    expect(diagnostics.silenceTransitions).toBeGreaterThan(300);
    expect(diagnostics.estimatedBytesSaved).toBeGreaterThan(1_000_000);
  });
});
