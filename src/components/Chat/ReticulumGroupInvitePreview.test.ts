import { describe, expect, it } from 'vitest';
import { parseReticulumGroupInviteLinks } from './ReticulumGroupInvitePreview';

describe('parseReticulumGroupInviteLinks', () => {
  it('keeps existing use-group join links valid', () => {
    expect(
      parseReticulumGroupInviteLinks(
        'qortal://use-group/action-join/groupid-1143'
      )
    ).toEqual([
      {
        groupId: '1143',
        link: 'qortal://use-group/action-join/groupid-1143',
        validSyntax: true,
      },
    ]);
  });

  it('does not mistake calendar actions for group invitations', () => {
    expect(
      parseReticulumGroupInviteLinks(
        'qortal://use-group/action-calendar/groupid-1143/eventid-06a3daa0-938c-40df-a7fe-a3cec373d992'
      )
    ).toEqual([]);
  });
});
