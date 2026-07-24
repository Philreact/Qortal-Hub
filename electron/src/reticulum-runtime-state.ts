type ReticulumRuntimeStateListener = (enabled: boolean) => void;

let enabled = true;
let generation = 0;
const listeners = new Set<ReticulumRuntimeStateListener>();

export function isReticulumRuntimeEnabled(): boolean {
  return enabled;
}

export function getReticulumRuntimeGeneration(): number {
  return generation;
}

export function setReticulumRuntimeEnabled(nextEnabled: boolean): void {
  if (enabled === nextEnabled) return;
  enabled = nextEnabled;
  generation += 1;
  for (const listener of listeners) listener(enabled);
}

export function invalidateReticulumRuntimeGeneration(): void {
  generation += 1;
}

export function subscribeToReticulumRuntimeState(
  listener: ReticulumRuntimeStateListener
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
