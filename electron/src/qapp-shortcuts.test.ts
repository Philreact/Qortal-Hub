import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'fs';
import { execFile, execFileSync } from 'child_process';
import { createServer } from 'net';
import { promisify } from 'util';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  installedQAppIconPng,
  installQAppShortcut,
  linuxDesktopEntry,
  qAppShortcutLaunchArgument,
  qAppShortcutStatus,
  repairQAppAppImageShortcuts,
  removeQAppShortcut,
  type QAppShortcutContext,
} from './qapp-shortcuts';

const tempRoots: string[] = [];
const runFile = promisify(execFile);
afterEach(() => {
  for (const root of tempRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function context(platform: NodeJS.Platform): QAppShortcutContext {
  const root = mkdtempSync(join(tmpdir(), 'qapp-shortcut-'));
  tempRoots.push(root);
  const iconPng = join(root, 'hub.png');
  copyFileSync(join(__dirname, '../assets/appIcon.png'), iconPng);
  return {
    platform,
    home: join(root, 'home'),
    appData: join(root, 'app-data'),
    execPath: join(root, "Qortal's Hub"),
    packaged: true,
    fallbackPng: iconPng,
    xdgDataHome: join(root, 'data home'),
    launchPort: 0,
  };
}

const identity = {
  service: 'APP' as const,
  name: "Alice's App",
  identifier: 'main',
};

describe('Q-App OS shortcuts', () => {
  it('forwards a Linux shortcut launch to a running Hub', async () => {
    const options = context('linux');
    writeFileSync(options.execPath, '#!/bin/sh\nprintf "fallback"\n', {
      mode: 0o700,
    });
    const received: unknown[] = [];
    const server = createServer((socket) => {
      let input = '';
      socket.on('data', (chunk) => {
        input += chunk.toString();
        const end = input.indexOf('\n');
        if (end < 0) return;
        received.push(JSON.parse(input.slice(0, end)));
        socket.end('OK\n');
      });
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve)
      );
      options.launchPort = (server.address() as { port: number }).port;
      await installQAppShortcut(identity, options);
      const support = join(options.appData, 'qortal-hub', 'qapp-launchers');
      const script = join(
        support,
        readdirSync(support).find((name) => name.endsWith('.sh'))!
      );
      const result = await runFile(script, { timeout: 5_000 });
      expect(result.stdout).toBe('');
      expect(received).toEqual([{ type: 'open-qapp', app: identity }]);
    } finally {
      server.close();
    }
  });

  it('creates a Linux application entry and launcher with an exact Q-App argument', async () => {
    const options = context('linux');
    const waitForRegistration = vi.fn(async () => {
      const desktopDir = join(options.xdgDataHome!, 'applications');
      expect(
        readdirSync(desktopDir).some((name) => name.endsWith('.desktop'))
      ).toBe(true);
    });
    options.waitForLinuxDesktopRegistration = waitForRegistration;
    writeFileSync(options.execPath, '#!/bin/sh\nprintf "%s" "$1"\n', {
      mode: 0o700,
    });
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: true,
      installed: false,
    });
    await installQAppShortcut(identity, options);
    expect(waitForRegistration).toHaveBeenCalledOnce();
    expect(await installedQAppIconPng(identity, options)).not.toBeNull();
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: true,
      installed: true,
    });
    const support = join(options.appData, 'qortal-hub', 'qapp-launchers');
    const script = join(
      support,
      readdirSync(support).find((name) => name.endsWith('.sh'))!
    );
    expect(execFileSync(script, { encoding: 'utf8' })).toBe(
      qAppShortcutLaunchArgument(identity)
    );
    const desktopDir = join(options.xdgDataHome!, 'applications');
    const desktopPath = join(desktopDir, readdirSync(desktopDir)[0]);
    const desktop = readFileSync(desktopPath, 'utf8');
    if (existsSync('/usr/bin/desktop-file-validate'))
      execFileSync('/usr/bin/desktop-file-validate', [desktopPath]);
    expect(desktop).toContain("Name=Alice's App");
    expect(desktop).toContain('Terminal=false');
    expect(desktop).toContain('StartupNotify=true');
    expect(desktop).toMatch(
      /StartupWMClass=qortal-qapp-alice-s-app-[a-f0-9]{16}/
    );
    expect(linuxDesktopEntry(identity, '/tmp/a% b', '/tmp/icon')).toContain(
      'Exec="/tmp/a%% b"'
    );
    await removeQAppShortcut(identity, options);
    expect(await installedQAppIconPng(identity, options)).toBeNull();
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: true,
      installed: false,
    });
  });

  it('repairs installed AppImage launchers when the AppImage moves', async () => {
    const options = context('linux');
    const oldImage = join(options.home, "Old Hub's.AppImage");
    const newImage = join(options.home, "New Hub's.AppImage");
    mkdirSync(options.home, { recursive: true });
    writeFileSync(oldImage, '#!/bin/sh\nprintf "old"\n', { mode: 0o700 });
    writeFileSync(newImage, '#!/bin/sh\nprintf "new:%s" "$1"\n', {
      mode: 0o700,
    });
    options.appImagePath = oldImage;
    await installQAppShortcut(identity, options);
    const support = join(options.appData, 'qortal-hub', 'qapp-launchers');
    const script = join(
      support,
      readdirSync(support).find((name) => name.endsWith('.sh'))!
    );
    const installedScript = readFileSync(script, 'utf8');
    expect(installedScript).toContain('# Qortal-Hub-AppImage-Launcher=1');
    // An existing installation predating the marker must still be repaired.
    writeFileSync(
      script,
      installedScript.replace('# Qortal-Hub-AppImage-Launcher=1\n', '')
    );
    options.appImagePath = newImage;
    expect(await repairQAppAppImageShortcuts(options)).toEqual({
      updated: 1,
      failed: 0,
    });
    expect(execFileSync(script, { encoding: 'utf8' })).toBe(
      `new:${qAppShortcutLaunchArgument(identity)}`
    );
    expect(await repairQAppAppImageShortcuts(options)).toEqual({
      updated: 0,
      failed: 0,
    });
  });

  it('repairs marked AppImage launchers even with a custom file extension', async () => {
    const options = context('linux');
    const oldImage = join(options.home, 'hub-old');
    const newImage = join(options.home, 'hub-new');
    mkdirSync(options.home, { recursive: true });
    writeFileSync(oldImage, '#!/bin/sh\n', { mode: 0o700 });
    writeFileSync(newImage, '#!/bin/sh\n', { mode: 0o700 });
    options.appImagePath = oldImage;
    await installQAppShortcut(identity, options);
    options.appImagePath = newImage;
    expect(await repairQAppAppImageShortcuts(options)).toEqual({
      updated: 1,
      failed: 0,
    });
  });

  it('leaves modified and non-AppImage launchers alone', async () => {
    const options = context('linux');
    const oldImage = join(options.home, 'old.AppImage');
    const newImage = join(options.home, 'new.AppImage');
    mkdirSync(options.home, { recursive: true });
    writeFileSync(oldImage, '#!/bin/sh\n', { mode: 0o700 });
    writeFileSync(newImage, '#!/bin/sh\n', { mode: 0o700 });
    options.appImagePath = oldImage;
    await installQAppShortcut(identity, options);
    const support = join(options.appData, 'qortal-hub', 'qapp-launchers');
    const script = join(
      support,
      readdirSync(support).find((name) => name.endsWith('.sh'))!
    );
    const original = readFileSync(script, 'utf8');
    options.appImagePath = newImage;
    options.packaged = false;
    expect(await repairQAppAppImageShortcuts(options)).toEqual({
      updated: 0,
      failed: 0,
    });
    options.packaged = true;
    writeFileSync(script, `${original}\n# user edit\n`);
    expect(await repairQAppAppImageShortcuts(options)).toEqual({
      updated: 0,
      failed: 0,
    });
    expect(readFileSync(script, 'utf8')).toBe(`${original}\n# user edit\n`);
  });

  it('does not switch a deb-installed shortcut to an AppImage', async () => {
    const options = context('linux');
    writeFileSync(options.execPath, '#!/bin/sh\n', { mode: 0o700 });
    await installQAppShortcut(identity, options);
    const support = join(options.appData, 'qortal-hub', 'qapp-launchers');
    const script = join(
      support,
      readdirSync(support).find((name) => name.endsWith('.sh'))!
    );
    const original = readFileSync(script, 'utf8');
    const image = join(options.home, 'Qortal Hub.AppImage');
    mkdirSync(options.home, { recursive: true });
    writeFileSync(image, '#!/bin/sh\n', { mode: 0o700 });
    options.appImagePath = image;
    expect(await repairQAppAppImageShortcuts(options)).toEqual({
      updated: 0,
      failed: 0,
    });
    expect(readFileSync(script, 'utf8')).toBe(original);
  });

  it('keeps an unpackaged Linux launch argument after sandbox setup', async () => {
    const options = context('linux');
    options.packaged = false;
    options.appPath = join(options.home, 'electron app');
    writeFileSync(options.execPath, '#!/bin/sh\nprintf "%s\\n" "$@"\n', {
      mode: 0o700,
    });
    await installQAppShortcut(identity, options);
    const support = join(options.appData, 'qortal-hub', 'qapp-launchers');
    const script = join(
      support,
      readdirSync(support).find((name) => name.endsWith('.sh'))!
    );
    execFileSync('sh', ['-n', script]);
    expect(
      execFileSync(script, { encoding: 'utf8' }).trim().split('\n')
    ).toEqual([options.appPath, qAppShortcutLaunchArgument(identity)]);
  });

  it('uses a per-user Windows Start Menu link and removes only the matching link', async () => {
    const options = context('win32');
    options.writeWindowsLink = (path, details) => {
      expect(details.icon).toMatch(/\.ico$/);
      expect(readFileSync(details.icon!).readUInt16LE(2)).toBe(1);
      writeFileSync(path, JSON.stringify(details));
      return true;
    };
    options.readWindowsLink = (path) => JSON.parse(readFileSync(path, 'utf8'));
    await installQAppShortcut(identity, options);
    const startMenu = join(
      options.appData,
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Qortal Hub'
    );
    expect(readdirSync(startMenu)[0]).toMatch(/^Alice's App\.lnk$/);
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: true,
      installed: true,
    });
    await removeQAppShortcut(identity, options);
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: true,
      installed: false,
    });
  });

  it('passes the project path when a Windows development shortcut starts Electron', async () => {
    const options = {
      ...context('win32'),
      packaged: false,
      appPath: 'C:\\Qortal Hub\\electron',
    };
    let argumentsWritten = '';
    options.writeWindowsLink = (path, details) => {
      argumentsWritten = details.args;
      writeFileSync(path, JSON.stringify(details));
      return true;
    };
    options.readWindowsLink = (path) => JSON.parse(readFileSync(path, 'utf8'));
    await installQAppShortcut(identity, options);
    expect(argumentsWritten).toBe(
      `"${options.appPath}" ${qAppShortcutLaunchArgument(identity)}`
    );
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: true,
      installed: true,
    });
  });

  it('creates and removes a macOS applet with a marker for the requested Q-App', async () => {
    const options = context('darwin');
    const compile = vi.fn(async (bundle: string, source: string) => {
      expect(source).toContain('--open-qapp=qortal://APP/Alice');
      mkdirSync(join(bundle, 'Contents', 'Resources'), { recursive: true });
    });
    options.compileAppleScript = compile;
    await installQAppShortcut(identity, options);
    expect(compile).toHaveBeenCalledOnce();
    expect(readdirSync(join(options.home, 'Applications'))[0]).toMatch(
      /^Alice's App\.app$/
    );
    const bundle = join(options.home, 'Applications', "Alice's App.app");
    expect(
      readFileSync(
        join(bundle, 'Contents', 'Resources', 'applet.icns')
      ).toString('ascii', 0, 4)
    ).toBe('icns');
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: true,
      installed: true,
    });
    await removeQAppShortcut(identity, options);
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: true,
      installed: false,
    });
  });

  it('launches an unpackaged Electron app with its project path', async () => {
    const options = {
      ...context('linux'),
      packaged: false,
      appPath: '/tmp/Qortal Hub/electron',
    };
    writeFileSync(options.execPath, '#!/bin/sh\nprintf "%s|%s" "$1" "$2"\n', {
      mode: 0o700,
    });
    await installQAppShortcut(identity, options);
    const support = join(options.appData, 'qortal-hub', 'qapp-launchers');
    const script = join(
      support,
      readdirSync(support).find((name) => name.endsWith('.sh'))!
    );
    expect(execFileSync(script, { encoding: 'utf8' })).toBe(
      `${options.appPath}|${qAppShortcutLaunchArgument(identity)}`
    );
  });

  it('requires an app path for an unpackaged Electron shortcut', async () => {
    const options = { ...context('linux'), packaged: false };
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: false,
      installed: false,
    });
    await expect(installQAppShortcut(identity, options)).rejects.toThrow(
      'QAPP_SHORTCUT_UNSUPPORTED'
    );
  });

  it('does not overwrite or remove a conflicting launcher file', async () => {
    const options = context('linux');
    writeFileSync(options.execPath, '#!/bin/sh\n', { mode: 0o700 });
    await installQAppShortcut(identity, options);
    const desktopDir = join(options.xdgDataHome!, 'applications');
    const desktopPath = join(desktopDir, readdirSync(desktopDir)[0]);
    writeFileSync(desktopPath, 'Unrelated launcher');
    expect(await qAppShortcutStatus(identity, options)).toEqual({
      supported: true,
      installed: false,
    });
    await expect(installQAppShortcut(identity, options)).rejects.toThrow(
      'QAPP_SHORTCUT_CONFLICT'
    );
    await removeQAppShortcut(identity, options);
    expect(readFileSync(desktopPath, 'utf8')).toBe('Unrelated launcher');
  });
});
