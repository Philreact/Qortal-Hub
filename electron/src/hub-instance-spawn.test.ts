import { describe, expect, it } from 'vitest';
import { hubInstanceSpawnSpec } from './hub-instance-spawn';

describe('Hub new-instance launch arguments', () => {
  it('launches the Electron app directory in development', () => {
    expect(
      hubInstanceSpawnSpec({
        execPath: '/electron',
        appPath: '/project/electron',
        packaged: false,
      })
    ).toEqual({
      executable: '/electron',
      args: ['/project/electron', '--new-instance'],
    });
  });

  it('launches the AppImage itself and carries a Q-App request', () => {
    expect(
      hubInstanceSpawnSpec({
        execPath: '/tmp/appimage/AppRun',
        appPath: '/tmp/appimage',
        packaged: true,
        appImagePath: '/apps/Hub.AppImage',
        app: { service: 'APP', name: 'Q-Tube' },
      })
    ).toEqual({
      executable: '/apps/Hub.AppImage',
      args: ['--new-instance', '--open-qapp=qortal://APP/Q-Tube'],
    });
  });
});
