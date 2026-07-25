import { describe, expect, it } from 'vitest';
import {
  groupSectionUsesSecretKey,
  shouldLoadSecretKeyForSection,
  shouldLoadSecretKeyOnGroupEntry,
} from './groupSecretKeyPolicy';

describe('group secret-key policy', () => {
  it('keeps the legacy private-group key flow when Reticulum Chat is disabled', () => {
    expect(shouldLoadSecretKeyOnGroupEntry(false, true)).toBe(true);
    expect(groupSectionUsesSecretKey(false, 'chat')).toBe(true);
  });

  it('does not require a private-group key for Reticulum Chat or QortalLand', () => {
    expect(shouldLoadSecretKeyOnGroupEntry(true, true)).toBe(false);
    expect(shouldLoadSecretKeyForSection(true, true, 'chat')).toBe(false);
    expect(groupSectionUsesSecretKey(true, 'chat')).toBe(false);
    expect(groupSectionUsesSecretKey(true, 'land')).toBe(false);
  });

  it('loads and gates only Threads with the private-group key in Reticulum mode', () => {
    expect(shouldLoadSecretKeyForSection(true, true, 'forum')).toBe(true);
    expect(groupSectionUsesSecretKey(true, 'forum')).toBe(true);
    expect(shouldLoadSecretKeyForSection(true, false, 'forum')).toBe(false);
  });
});
