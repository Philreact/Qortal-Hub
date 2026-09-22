import { describe, expect, it } from 'vitest';
import { routeOsNotification } from './os-notification-routing';

const hosts = [{ hostId: 7, app: { service: 'APP' as const, name: 'Q-Tube' } }];

describe('OS notification routing', () => {
  it('preserves Hub notifications while Hub is visible', () => {
    expect(routeOsNotification(true, undefined, hosts)).toEqual({
      kind: 'hub',
    });
  });

  it('opens an existing Q-App window even when Hub is visible', () => {
    expect(
      routeOsNotification(true, { appName: 'Q-Tube', appService: 'APP' }, hosts)
    ).toEqual({ kind: 'app', hostId: 7 });
  });

  it('suppresses Hub and closed-app notifications when Hub is hidden', () => {
    expect(routeOsNotification(false, undefined, hosts)).toEqual({
      kind: 'suppress',
    });
    expect(
      routeOsNotification(
        false,
        { appName: 'Q-Mail', appService: 'APP' },
        hosts
      )
    ).toEqual({ kind: 'suppress' });
  });

  it('routes a matching Q-App deep link and keeps its query', () => {
    expect(
      routeOsNotification(
        false,
        { appName: 'Q-Tube', appService: 'APP' },
        hosts
      )
    ).toEqual({ kind: 'app', hostId: 7 });
    expect(
      routeOsNotification(
        false,
        {
          appName: 'Q-Tube',
          appService: 'APP',
          link: 'qortal://APP/Q-Tube/watch/abc?view=comments',
        },
        hosts
      )
    ).toEqual({ kind: 'app', hostId: 7, path: 'watch/abc?view=comments' });
    expect(
      routeOsNotification(
        false,
        {
          appName: 'Q-Tube',
          appService: 'APP',
          link: 'qortal://APP/Q-Tube',
        },
        hosts
      )
    ).toEqual({ kind: 'app', hostId: 7, path: '' });
  });

  it('rejects mismatched links and ambiguous app variants', () => {
    expect(
      routeOsNotification(
        false,
        { appName: 'Q-Tube', appService: 'APP', link: 'qortal://APP/Other' },
        hosts
      )
    ).toEqual({ kind: 'suppress' });
    expect(
      routeOsNotification(false, { appName: 'Q-Tube', appService: 'APP' }, [
        ...hosts,
        { hostId: 8, app: { service: 'APP', name: 'Q-Tube' } },
      ])
    ).toEqual({ kind: 'suppress' });
    expect(
      routeOsNotification(
        false,
        {
          appName: 'Q-Tube',
          appService: 'APP',
          link: 'qortal://APP/Q-Tube?identifier=other',
        },
        hosts
      )
    ).toEqual({ kind: 'suppress' });
  });

  it('targets the requesting app identifier', () => {
    const variants = [
      {
        hostId: 7,
        app: { service: 'APP' as const, name: 'Q-Tube', identifier: 'alpha' },
      },
      {
        hostId: 8,
        app: { service: 'APP' as const, name: 'Q-Tube', identifier: 'beta' },
      },
    ];
    expect(
      routeOsNotification(
        false,
        { appName: 'Q-Tube', appService: 'APP', appIdentifier: 'alpha' },
        variants
      )
    ).toEqual({ kind: 'app', hostId: 7 });
    expect(
      routeOsNotification(
        false,
        {
          appName: 'Q-Tube',
          appService: 'APP',
          appIdentifier: 'alpha',
          link: 'qortal://APP/Q-Tube?identifier=beta',
        },
        variants
      )
    ).toEqual({ kind: 'suppress' });
  });
});
