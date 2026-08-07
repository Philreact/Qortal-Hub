import { describe, expect, it } from 'vitest';
import { createRefcountedSubscriberSet } from './refcounted-subscriber-set';

describe('createRefcountedSubscriberSet', () => {
  it('keeps a shared subscriber active until every consumer unsubscribes', () => {
    const registry = createRefcountedSubscriberSet<object>();
    const renderer = {};

    registry.subscribe(renderer);
    registry.subscribe(renderer);
    expect(registry.getRefCount(renderer)).toBe(2);
    expect(registry.subscribers.has(renderer)).toBe(true);

    registry.unsubscribe(renderer);
    expect(registry.getRefCount(renderer)).toBe(1);
    expect(registry.subscribers.has(renderer)).toBe(true);

    registry.unsubscribe(renderer);
    expect(registry.getRefCount(renderer)).toBe(0);
    expect(registry.subscribers.has(renderer)).toBe(false);
  });

  it('ignores unmatched unsubscriptions without producing a negative count', () => {
    const registry = createRefcountedSubscriberSet<object>();
    const renderer = {};

    registry.unsubscribe(renderer);
    expect(registry.getRefCount(renderer)).toBe(0);
    expect(registry.subscribers.has(renderer)).toBe(false);
  });

  it('drops all references when a renderer is no longer usable', () => {
    const registry = createRefcountedSubscriberSet<object>();
    const renderer = {};

    registry.subscribe(renderer);
    registry.subscribe(renderer);
    registry.drop(renderer);

    expect(registry.getRefCount(renderer)).toBe(0);
    expect(registry.subscribers.has(renderer)).toBe(false);
  });
});
