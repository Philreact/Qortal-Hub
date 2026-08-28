import { beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupReticulumSelfWelcomeMarkers,
  RETICULUM_SELF_WELCOME_RECENT_JOIN_MS,
  RETICULUM_SELF_WELCOME_STORAGE_PREFIX,
  reticulumSelfWelcomeStorageKey,
} from './reticulumSelfWelcomeStorage';

const NOW = 2_000_000_000_000;

const storedWelcomeKeys = () =>
  Object.keys(window.localStorage).filter((key) =>
    key.startsWith(`${RETICULUM_SELF_WELCOME_STORAGE_PREFIX}:`)
  );

describe('Reticulum self-welcome marker cleanup', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('removes obsolete periods for the current group membership', () => {
    const current = { address: 'Q-address', groupId: 1144, joinedAt: NOW - 10 };
    const obsolete = { ...current, joinedAt: NOW - 20 };
    const currentKey = reticulumSelfWelcomeStorageKey(current);
    const obsoleteKey = reticulumSelfWelcomeStorageKey(obsolete);
    window.localStorage.setItem(currentKey, 'published');
    window.localStorage.setItem(obsoleteKey, 'published');

    cleanupReticulumSelfWelcomeMarkers(current, NOW);

    expect(window.localStorage.getItem(currentKey)).toBe('published');
    expect(window.localStorage.getItem(obsoleteKey)).toBeNull();
  });

  it('removes old inactive markers while retaining all recent memberships', () => {
    const current = {
      address: 'Q-current',
      groupId: 1144,
      joinedAt: NOW - RETICULUM_SELF_WELCOME_RECENT_JOIN_MS - 10,
    };
    const recent = {
      address: 'Q-other',
      groupId: 1143,
      joinedAt: NOW - RETICULUM_SELF_WELCOME_RECENT_JOIN_MS + 10,
    };
    const old = {
      address: 'Q-old',
      groupId: 716,
      joinedAt: NOW - RETICULUM_SELF_WELCOME_RECENT_JOIN_MS - 20,
    };
    for (const identity of [current, recent, old]) {
      window.localStorage.setItem(
        reticulumSelfWelcomeStorageKey(identity),
        'baseline'
      );
    }

    cleanupReticulumSelfWelcomeMarkers(current, NOW);

    expect(
      window.localStorage.getItem(reticulumSelfWelcomeStorageKey(current))
    ).toBe('baseline');
    expect(
      window.localStorage.getItem(reticulumSelfWelcomeStorageKey(recent))
    ).toBe('baseline');
    expect(
      window.localStorage.getItem(reticulumSelfWelcomeStorageKey(old))
    ).toBeNull();
  });

  it('removes malformed markers without touching unrelated storage', () => {
    window.localStorage.setItem(
      `${RETICULUM_SELF_WELCOME_STORAGE_PREFIX}:broken`,
      'baseline'
    );
    window.localStorage.setItem('unrelated-key', 'keep');

    cleanupReticulumSelfWelcomeMarkers(
      { address: 'Q-address', groupId: 1144, joinedAt: NOW },
      NOW
    );

    expect(storedWelcomeKeys()).toEqual([]);
    expect(window.localStorage.getItem('unrelated-key')).toBe('keep');
  });
});
