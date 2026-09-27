import { describe, expect, it } from 'vitest';
import { rendererCpuProfileDurationSeconds } from './renderer-cpu-profile';

describe('renderer CPU profile activation', () => {
  it('stays disabled without the explicit command-line flag', () => {
    expect(rendererCpuProfileDurationSeconds(['electron', '.'])).toBeNull();
  });

  it('ignores a duration environment variable without the flag', () => {
    const previousValue = process.env.QORTAL_RENDERER_PROFILE_SECONDS;
    process.env.QORTAL_RENDERER_PROFILE_SECONDS = '900';
    try {
      expect(rendererCpuProfileDurationSeconds(['electron', '.'])).toBeNull();
    } finally {
      if (previousValue === undefined) {
        delete process.env.QORTAL_RENDERER_PROFILE_SECONDS;
      } else {
        process.env.QORTAL_RENDERER_PROFILE_SECONDS = previousValue;
      }
    }
  });

  it('uses the default duration for the bare command-line flag', () => {
    expect(
      rendererCpuProfileDurationSeconds(['electron', '.', '--profile-renderer'])
    ).toBe(60);
  });

  it('uses and limits an explicit command-line duration', () => {
    expect(
      rendererCpuProfileDurationSeconds([
        'electron',
        '.',
        '--profile-renderer=900',
      ])
    ).toBe(900);
    expect(
      rendererCpuProfileDurationSeconds([
        'electron',
        '.',
        '--profile-renderer=99999',
      ])
    ).toBe(3600);
  });

  it('does not mistake the delay flag for the activation flag', () => {
    expect(
      rendererCpuProfileDurationSeconds([
        'electron',
        '.',
        '--profile-renderer-delay=10',
      ])
    ).toBeNull();
  });
});
