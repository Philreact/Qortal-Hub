// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  parseHubLaunchCommand,
  parseHubLaunchMessage,
  parseQAppLaunchUrl,
} from './qapp-launch';

describe('Q-App launch routing', () => {
  it('parses a Qortal APP link without opening an arbitrary URL', () => {
    expect(
      parseHubLaunchCommand([
        'hub',
        '--open-qapp=qortal://APP/Q-Tube/video?identifier=main',
      ])
    ).toEqual({
      type: 'open-qapp',
      app: {
        service: 'APP',
        name: 'Q-Tube',
        path: 'video',
        identifier: 'main',
      },
    });
    expect(parseQAppLaunchUrl('https://example.com')).toBeNull();
    expect(parseQAppLaunchUrl('qortal://WEBSITE/Q-Tube')).toBeNull();
    expect(parseQAppLaunchUrl('qortal://APP/')).toBeNull();
    expect(parseQAppLaunchUrl('qortal://APP/Other%2FApp')).toBeNull();
  });

  it('rejects malformed local launch messages', () => {
    expect(parseHubLaunchMessage({ type: 'focus' })).toEqual({ type: 'focus' });
    expect(parseHubLaunchMessage({ type: 'show-launcher' })).toEqual({
      type: 'show-launcher',
    });
    expect(
      parseHubLaunchMessage({
        type: 'open-qapp',
        app: { service: 'WEBSITE', name: 'Other' },
      })
    ).toBeNull();
    expect(
      parseHubLaunchMessage({
        type: 'open-qapp',
        app: { service: 'APP', name: '' },
      })
    ).toBeNull();
  });
});
