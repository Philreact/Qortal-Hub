type ReticulumMentionSummary = {
  mentionCount?: number;
};

type SequenceRef = {
  current: number;
};

export const getReticulumMentionBadgeCount = (
  summaries: Record<string, ReticulumMentionSummary>
): number =>
  Object.values(summaries || {}).reduce(
    (total, summary) =>
      total + Math.max(0, Number(summary?.mentionCount) || 0),
    0
  );

export const beginReticulumSummaryRefresh = (
  sequenceRef: SequenceRef
): (() => boolean) => {
  const refreshSequence = ++sequenceRef.current;
  return () => refreshSequence !== sequenceRef.current;
};
