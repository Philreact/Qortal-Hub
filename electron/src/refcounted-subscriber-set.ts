export function createRefcountedSubscriberSet<T>() {
  const subscribers = new Set<T>();
  const refCounts = new Map<T, number>();

  const subscribe = (subscriber: T): void => {
    const nextCount = (refCounts.get(subscriber) ?? 0) + 1;
    refCounts.set(subscriber, nextCount);
    subscribers.add(subscriber);
  };

  const unsubscribe = (subscriber: T): void => {
    const currentCount = refCounts.get(subscriber) ?? 0;
    if (currentCount <= 1) {
      refCounts.delete(subscriber);
      subscribers.delete(subscriber);
      return;
    }
    refCounts.set(subscriber, currentCount - 1);
  };

  const drop = (subscriber: T): void => {
    refCounts.delete(subscriber);
    subscribers.delete(subscriber);
  };

  const getRefCount = (subscriber: T): number => refCounts.get(subscriber) ?? 0;

  return {
    subscribers,
    subscribe,
    unsubscribe,
    drop,
    getRefCount,
  };
}
