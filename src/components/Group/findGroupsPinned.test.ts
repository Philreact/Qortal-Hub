import { describe, expect, it } from 'vitest';
import {
  comparePinnedTopGroups,
  isPinnedTopGroup,
  isQortalProjectGroup,
  QORTAL_PROJECT_GROUP_ID,
} from './findGroupsPinned';

describe('findGroupsPinned', () => {
  it('identifies Qortal Project by its stable group id', () => {
    expect(isQortalProjectGroup({ groupId: QORTAL_PROJECT_GROUP_ID })).toBe(
      true
    );
    expect(
      isQortalProjectGroup({ groupId: String(QORTAL_PROJECT_GROUP_ID) })
    ).toBe(true);
    expect(isQortalProjectGroup({ groupId: 1 })).toBe(false);
  });

  it('sorts Qortal Project ahead of other groups without reordering peers', () => {
    expect(
      comparePinnedTopGroups(
        { groupId: 20 },
        { groupId: QORTAL_PROJECT_GROUP_ID }
      )
    ).toBe(1);
    expect(
      comparePinnedTopGroups(
        { groupId: QORTAL_PROJECT_GROUP_ID },
        { groupId: 20 }
      )
    ).toBe(-1);
    expect(comparePinnedTopGroups({ groupId: 20 }, { groupId: 30 })).toBe(0);
  });

  it('marks the group as pinned only in the Top view', () => {
    const group = { groupId: QORTAL_PROJECT_GROUP_ID };

    expect(isPinnedTopGroup('top', group)).toBe(true);
    expect(isPinnedTopGroup('active', group)).toBe(false);
    expect(isPinnedTopGroup('newest', group)).toBe(false);
  });
});
