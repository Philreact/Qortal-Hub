import { describe, expect, it, vi } from 'vitest';
import {
  getReticulumRuntimeGeneration,
  invalidateReticulumRuntimeGeneration,
  isReticulumRuntimeEnabled,
  setReticulumRuntimeEnabled,
  subscribeToReticulumRuntimeState,
} from './reticulum-runtime-state';

describe('Reticulum runtime state', () => {
  it('increments its generation only for meaningful state changes', () => {
    const initialGeneration = getReticulumRuntimeGeneration();
    const listener = vi.fn();
    const unsubscribe = subscribeToReticulumRuntimeState(listener);

    setReticulumRuntimeEnabled(false);
    expect(isReticulumRuntimeEnabled()).toBe(false);
    expect(getReticulumRuntimeGeneration()).toBe(initialGeneration + 1);
    expect(listener).toHaveBeenLastCalledWith(false);

    setReticulumRuntimeEnabled(false);
    expect(getReticulumRuntimeGeneration()).toBe(initialGeneration + 1);
    expect(listener).toHaveBeenCalledTimes(1);

    invalidateReticulumRuntimeGeneration();
    expect(getReticulumRuntimeGeneration()).toBe(initialGeneration + 2);

    setReticulumRuntimeEnabled(true);
    expect(isReticulumRuntimeEnabled()).toBe(true);
    expect(getReticulumRuntimeGeneration()).toBe(initialGeneration + 3);
    expect(listener).toHaveBeenLastCalledWith(true);
    unsubscribe();
  });
});
