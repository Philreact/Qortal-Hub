import { describe, expect, it } from 'vitest';
import { canEditOwnReticulumMessage } from './reticulumMessagePermissions';

describe('Reticulum message permissions', () => {
  it('allows an author to edit a Reticulum message regardless of the legacy encryption marker', () => {
    for (const isNotEncrypted of [true, false]) {
      expect(
        canEditOwnReticulumMessage({
          isOfficialGroupWelcome: false,
          message: {
            sender: 'Qauthor',
            reticulumChat: true,
            isNotEncrypted,
          },
          myAddress: 'Qauthor',
        })
      ).toBe(true);
    }
  });

  it('does not allow editing another author or an official welcome message', () => {
    expect(
      canEditOwnReticulumMessage({
        isOfficialGroupWelcome: false,
        message: { sender: 'Qother', reticulumChat: true },
        myAddress: 'Qauthor',
      })
    ).toBe(false);
    expect(
      canEditOwnReticulumMessage({
        isOfficialGroupWelcome: true,
        message: { sender: 'Qauthor', reticulumChat: true },
        myAddress: 'Qauthor',
      })
    ).toBe(false);
  });
});
