import { describe, expect, it } from 'vitest';
import { parseQAppDirectNotification } from './qappDirectNotification';

describe('direct Q-App notification input', () => {
  it('labels the app and accepts a same-app page link', () => {
    expect(
      parseQAppDirectNotification(
        {
          title: 'New reply',
          body: 'Alice replied to your video.',
          link: 'qortal://APP/Q-Tube/video/123?view=comments',
        },
        'Q-Tube'
      )
    ).toEqual({
      title: 'Q-Tube · New reply',
      body: 'Alice replied to your video.',
      link: 'qortal://APP/Q-Tube/video/123?view=comments',
    });
  });

  it('rejects another app or identifier and malformed text', () => {
    expect(
      parseQAppDirectNotification(
        { body: 'Hello', link: 'qortal://APP/Other' },
        'Q-Tube'
      )
    ).toBeNull();
    expect(
      parseQAppDirectNotification(
        { body: 'Hello', link: 'qortal://APP/Q-Tube?identifier=other' },
        'Q-Tube',
        'mine'
      )
    ).toBeNull();
    expect(parseQAppDirectNotification({ body: '' }, 'Q-Tube')).toBeNull();
    expect(
      parseQAppDirectNotification({ body: 'Hello\u0007' }, 'Q-Tube')
    ).toBeNull();
  });

  it('keeps a deep link within the requesting app variant', () => {
    expect(
      parseQAppDirectNotification(
        { body: 'New video', link: 'qortal://APP/Q-Tube/video/123' },
        'Q-Tube',
        'alpha'
      )?.link
    ).toBe('qortal://APP/Q-Tube/video/123?identifier=alpha');
  });
});
