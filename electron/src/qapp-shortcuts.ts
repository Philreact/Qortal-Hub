import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { constants as fsConstants, promises as fs } from 'fs';
import { dirname, isAbsolute, join } from 'path';
import {
  DEFAULT_HUB_LAUNCH_PORT,
  parseHubLaunchCommand,
  type QAppLaunch,
} from './qapp-launch';
import {
  pngToIcns,
  pngToIco,
  qAppIconPng,
  type QAppIconSource,
} from './qapp-icon';

const runFile = promisify(execFile);

export type QAppShortcutContext = QAppIconSource & {
  platform: NodeJS.Platform;
  home: string;
  appData: string;
  execPath: string;
  packaged: boolean;
  appPath?: string;
  appImagePath?: string;
  xdgDataHome?: string;
  launchPort?: number;
  waitForLinuxDesktopRegistration?: () => Promise<void>;
  writeWindowsLink?: (
    path: string,
    options: {
      target: string;
      args: string;
      description: string;
      icon?: string;
    }
  ) => boolean;
  readWindowsLink?: (path: string) => { args?: string };
  compileAppleScript?: (bundlePath: string, source: string) => Promise<void>;
};

function shortcutHash(identity: QAppLaunch): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        identity.service,
        identity.name.toLowerCase(),
        identity.identifier ?? '',
      ])
    )
    .digest('hex')
    .slice(0, 16);
}

function shortcutStem(identity: QAppLaunch): string {
  const slug =
    identity.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'app';
  return `qortal-qapp-${slug}-${shortcutHash(identity)}`;
}

export function qAppShortcutWmClass(identity: QAppLaunch): string {
  return shortcutStem(identity);
}

export function qAppShortcutLaunchArgument(identity: QAppLaunch): string {
  const url = `qortal://APP/${encodeURIComponent(identity.name)}${identity.identifier ? `?identifier=${encodeURIComponent(identity.identifier)}` : ''}`;
  return `--open-qapp=${url}`;
}

function shortcutTitle(identity: QAppLaunch): string {
  return identity.name;
}

function shortcutDisplayFileName(identity: QAppLaunch): string {
  const name = identity.name
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 60);
  return name;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function windowsQuote(value: string): string {
  return `"${value.replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`).replace(/(\\+)$/g, '$1$1')}"`;
}

function windowsLaunchArguments(
  identity: QAppLaunch,
  context: QAppShortcutContext
): string {
  const argument = qAppShortcutLaunchArgument(identity);
  return context.packaged
    ? argument
    : `${windowsQuote(context.appPath!)} ${argument}`;
}

function desktopValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '')
    .replace(/\t/g, '\\t');
}

function desktopExecQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('QAPP_SHORTCUT_INVALID_PATH');
  return `"${value.replace(/\\/g, '\\\\\\\\').replace(/"/g, '\\\\"').replace(/\$/g, '\\\\$').replace(/`/g, '\\\\`').replace(/%/g, '%%')}"`;
}

export function linuxDesktopEntry(
  identity: QAppLaunch,
  scriptPath: string,
  iconPath: string
): string {
  return `[Desktop Entry]\nType=Application\nVersion=1.0\nName=${desktopValue(shortcutTitle(identity))}\nExec=${desktopExecQuote(scriptPath)}\nIcon=${desktopValue(iconPath)}\nTerminal=false\nStartupNotify=true\nStartupWMClass=${qAppShortcutWmClass(identity)}\nCategories=Network;\nX-Qortal-Hub-QApp=${shortcutHash(identity)}\n`;
}

function windowsLinkPath(
  identity: QAppLaunch,
  context: QAppShortcutContext
): string {
  return join(
    context.appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Qortal Hub',
    `${shortcutDisplayFileName(identity)}.lnk`
  );
}

function windowsIconPath(identity: QAppLaunch, context: QAppShortcutContext) {
  return join(
    context.appData,
    'qortal-hub',
    'qapp-launchers',
    `${shortcutStem(identity)}.ico`
  );
}

function linuxPaths(identity: QAppLaunch, context: QAppShortcutContext) {
  const dataHome =
    context.xdgDataHome && isAbsolute(context.xdgDataHome)
      ? context.xdgDataHome
      : join(context.home, '.local', 'share');
  const stem = shortcutStem(identity);
  const supportDir = join(context.appData, 'qortal-hub', 'qapp-launchers');
  return {
    desktop: join(dataHome, 'applications', `${stem}.desktop`),
    script: join(supportDir, `${stem}.sh`),
    icon: join(supportDir, `${stem}.png`),
  };
}

function linuxLauncherScript(
  identity: QAppLaunch,
  context: QAppShortcutContext,
  executable: string,
  includeAppImageMarker = Boolean(
    context.packaged && context.appImagePath && isAbsolute(context.appImagePath)
  )
): string {
  const argument = qAppShortcutLaunchArgument(identity);
  const application = context.packaged
    ? ''
    : `${shellQuote(context.appPath!)} `;
  const message = JSON.stringify({ type: 'open-qapp', app: identity });
  // Unpackaged Electron's bundled helper is not setuid. Ubuntu can also
  // restrict user namespaces for apps launched by GNOME, so use a trusted
  // system helper when one is available instead of disabling the sandbox.
  const unpackagedSandboxSetup = context.packaged
    ? ''
    : `electron_sandbox=${shellQuote(join(dirname(executable), 'chrome-sandbox'))}
sandbox_flag=''
if [ ! -u "$electron_sandbox" ] || [ "$(stat -Lc %u "$electron_sandbox" 2>/dev/null)" != 0 ]; then
  for helper in /opt/google/chrome/chrome-sandbox /usr/lib/chromium/chrome-sandbox /usr/lib/chromium-browser/chrome-sandbox; do
    if [ -x "$helper" ] && [ -u "$helper" ] && [ "$(stat -Lc %u "$helper" 2>/dev/null)" = 0 ]; then
      if [ -e "$electron_sandbox" ] && [ ! -e "$electron_sandbox.unconfigured" ]; then
        cp "$electron_sandbox" "$electron_sandbox.unconfigured" 2>/dev/null || true
      fi
      ln -sfn "$helper" "$electron_sandbox"
      break
    fi
  done
  if { [ ! -u "$electron_sandbox" ] || [ "$(stat -Lc %u "$electron_sandbox" 2>/dev/null)" != 0 ]; } && command -v unshare >/dev/null 2>&1 && unshare -Ur true >/dev/null 2>&1; then
    sandbox_flag='--disable-setuid-sandbox'
  fi
fi
`;
  const sandboxArgument = context.packaged ? '' : '$sandbox_flag ';
  const appImageMarker = includeAppImageMarker
    ? '# Qortal-Hub-AppImage-Launcher=1\n'
    : '';
  const script = `#!/bin/sh
${appImageMarker}if command -v python3 >/dev/null 2>&1; then
  if python3 - ${shellQuote(message)} <<'PY'
import socket
import sys

try:
    with socket.create_connection(('127.0.0.1', ${context.launchPort ?? DEFAULT_HUB_LAUNCH_PORT}), timeout=2) as connection:
        connection.sendall((sys.argv[1] + '\\n').encode('utf-8'))
        response = connection.makefile('rb').readline(16)
    sys.exit(0 if response == b'OK\\n' else 1)
except OSError:
    sys.exit(1)
PY
  then
    exit 0
  fi
fi
unset ELECTRON_RUN_AS_NODE
${unpackagedSandboxSetup}exec ${shellQuote(executable)} ${sandboxArgument}${application}${shellQuote(argument)} "$@"
`;
  return script;
}

function macPaths(identity: QAppLaunch, context: QAppShortcutContext) {
  const bundle = join(
    context.home,
    'Applications',
    `${shortcutDisplayFileName(identity)}.app`
  );
  return {
    bundle,
    marker: join(bundle, 'Contents', 'Resources', 'qortal-hub-qapp.txt'),
    icon: join(bundle, 'Contents', 'Resources', 'applet.icns'),
  };
}

async function fileText(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function qAppShortcutStatus(
  identity: QAppLaunch,
  context: QAppShortcutContext
): Promise<{ supported: boolean; installed: boolean }> {
  if (
    (!context.packaged && !context.appPath) ||
    !['linux', 'win32', 'darwin'].includes(context.platform)
  )
    return { supported: false, installed: false };
  const argument = qAppShortcutLaunchArgument(identity);
  if (context.platform === 'win32') {
    const path = windowsLinkPath(identity, context);
    try {
      await fs.access(path);
      return {
        supported: true,
        installed:
          context.readWindowsLink?.(path)?.args?.endsWith(argument) ?? false,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { supported: true, installed: false };
      throw error;
    }
  }
  if (context.platform === 'linux') {
    const text = await fileText(linuxPaths(identity, context).desktop);
    return {
      supported: true,
      installed:
        text?.includes(`X-Qortal-Hub-QApp=${shortcutHash(identity)}\n`) ??
        false,
    };
  }
  const marker = await fileText(macPaths(identity, context).marker);
  return { supported: true, installed: marker === argument };
}

export async function installedQAppIconPng(
  identity: QAppLaunch,
  context: QAppShortcutContext
): Promise<Buffer | null> {
  if (context.platform !== 'linux') return null;
  if (!(await qAppShortcutStatus(identity, context)).installed) return null;
  try {
    return await fs.readFile(linuxPaths(identity, context).icon);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function installQAppShortcut(
  identity: QAppLaunch,
  context: QAppShortcutContext
): Promise<void> {
  const status = await qAppShortcutStatus(identity, context);
  if (!status.supported) throw new Error('QAPP_SHORTCUT_UNSUPPORTED');
  if (status.installed) return;
  const argument = qAppShortcutLaunchArgument(identity);
  if (context.platform === 'win32') {
    const path = windowsLinkPath(identity, context);
    if (await pathExists(path)) throw new Error('QAPP_SHORTCUT_CONFLICT');
    const icon = windowsIconPath(identity, context);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.mkdir(dirname(icon), { recursive: true });
    await fs.writeFile(icon, pngToIco(await qAppIconPng(identity, context)));
    if (
      !context.writeWindowsLink?.(path, {
        target: context.execPath,
        args: windowsLaunchArguments(identity, context),
        description: shortcutTitle(identity),
        icon,
      })
    ) {
      await fs.rm(icon, { force: true });
      throw new Error('QAPP_SHORTCUT_FAILED');
    }
    return;
  }
  if (context.platform === 'linux') {
    const paths = linuxPaths(identity, context);
    if (await pathExists(paths.desktop))
      throw new Error('QAPP_SHORTCUT_CONFLICT');
    await fs.mkdir(dirname(paths.script), { recursive: true });
    await fs.mkdir(dirname(paths.desktop), { recursive: true });
    await fs.writeFile(paths.icon, await qAppIconPng(identity, context));
    const executable =
      context.appImagePath && isAbsolute(context.appImagePath)
        ? context.appImagePath
        : context.execPath;
    const script = linuxLauncherScript(identity, context, executable);
    await fs.writeFile(paths.script, script, { mode: 0o700 });
    await fs.writeFile(
      paths.desktop,
      linuxDesktopEntry(identity, paths.script, paths.icon),
      { flag: 'wx', mode: 0o644 }
    );
    await context.waitForLinuxDesktopRegistration?.();
    return;
  }
  const paths = macPaths(identity, context);
  if (await pathExists(paths.bundle)) throw new Error('QAPP_SHORTCUT_CONFLICT');
  await fs.mkdir(dirname(paths.bundle), { recursive: true });
  const application = context.packaged
    ? ''
    : `${shellQuote(context.appPath!)} `;
  const command = `nohup ${shellQuote(context.execPath)} ${application}${shellQuote(argument)} >/dev/null 2>&1 &`;
  const source = `do shell script "${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  try {
    if (context.compileAppleScript)
      await context.compileAppleScript(paths.bundle, source);
    else
      await runFile('/usr/bin/osacompile', ['-o', paths.bundle, '-e', source]);
    await fs.writeFile(
      paths.icon,
      await pngToIcns(await qAppIconPng(identity, context))
    );
    await fs.writeFile(paths.marker, argument, { flag: 'wx' });
  } catch (error) {
    await fs.rm(paths.bundle, { recursive: true, force: true });
    throw error;
  }
}

function readShellQuotedWord(
  line: string,
  start: number
): { value: string; end: number } | null {
  if (line[start] !== "'") return null;
  let value = '';
  let offset = start;
  while (offset < line.length) {
    const end = line.indexOf("'", offset + 1);
    if (end < 0) return null;
    value += line.slice(offset + 1, end);
    offset = end + 1;
    if (!line.startsWith("\\'", offset)) return { value, end: offset };
    value += "'";
    offset += 2;
    if (line[offset] !== "'") return null;
  }
  return null;
}

function installedLinuxLauncher(
  script: string
): { executable: string; identity: QAppLaunch } | null {
  const line = script.split('\n').find((item) => item.startsWith('exec '));
  if (!line) return null;
  const executable = readShellQuotedWord(line, 5);
  if (!executable || line[executable.end] !== ' ') return null;
  const argument = readShellQuotedWord(line, executable.end + 1);
  if (!argument || line.slice(argument.end) !== ' "$@"') return null;
  const command = parseHubLaunchCommand([argument.value]);
  if (
    command?.type !== 'open-qapp' ||
    qAppShortcutLaunchArgument(command.app) !== argument.value ||
    !isAbsolute(executable.value)
  )
    return null;
  return { executable: executable.value, identity: command.app };
}

export async function repairQAppAppImageShortcuts(
  context: QAppShortcutContext
): Promise<{ updated: number; failed: number }> {
  const current = context.appImagePath;
  if (
    context.platform !== 'linux' ||
    !context.packaged ||
    !current ||
    !isAbsolute(current)
  )
    return { updated: 0, failed: 0 };
  const executable = await fs.stat(current).catch(() => null);
  if (!executable?.isFile()) return { updated: 0, failed: 0 };
  try {
    await fs.access(current, fsConstants.X_OK);
  } catch {
    return { updated: 0, failed: 0 };
  }
  const supportDir = join(context.appData, 'qortal-hub', 'qapp-launchers');
  const supportStat = await fs.lstat(supportDir).catch(() => null);
  if (!supportStat?.isDirectory()) return { updated: 0, failed: 0 };
  const entries = await fs.readdir(supportDir, { withFileTypes: true });
  let updated = 0;
  let failed = 0;
  for (const entry of entries) {
    if (
      !entry.isFile() ||
      !/^qortal-qapp-[a-z0-9-]+-[a-f0-9]{16}\.sh$/.test(entry.name)
    )
      continue;
    const scriptPath = join(supportDir, entry.name);
    try {
      const script = await fs.readFile(scriptPath, 'utf8');
      const installed = installedLinuxLauncher(script);
      if (
        !installed ||
        installed.executable === current ||
        // Older AppImage launchers have no marker; their path is the only clue.
        (!script.startsWith('#!/bin/sh\n# Qortal-Hub-AppImage-Launcher=1\n') &&
          !installed.executable.toLowerCase().endsWith('.appimage'))
      )
        continue;
      const paths = linuxPaths(installed.identity, context);
      if (paths.script !== scriptPath) continue;
      const desktopStat = await fs.lstat(paths.desktop).catch(() => null);
      if (!desktopStat?.isFile()) continue;
      const desktop = await fs.readFile(paths.desktop, 'utf8');
      const oldContext = { ...context, appImagePath: installed.executable };
      if (
        desktop !==
          linuxDesktopEntry(installed.identity, paths.script, paths.icon) ||
        (script !==
          linuxLauncherScript(
            installed.identity,
            oldContext,
            installed.executable
          ) &&
          script !==
            linuxLauncherScript(
              installed.identity,
              oldContext,
              installed.executable,
              false
            ))
      )
        continue;
      const temporary = `${scriptPath}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(
          temporary,
          linuxLauncherScript(installed.identity, context, current),
          { flag: 'wx', mode: 0o700 }
        );
        if ((await fs.readFile(scriptPath, 'utf8')) !== script) continue;
        await fs.rename(temporary, scriptPath);
        updated++;
      } finally {
        await fs.rm(temporary, { force: true });
      }
    } catch {
      failed++;
    }
  }
  return { updated, failed };
}

export async function removeQAppShortcut(
  identity: QAppLaunch,
  context: QAppShortcutContext
): Promise<void> {
  const status = await qAppShortcutStatus(identity, context);
  if (!status.supported) throw new Error('QAPP_SHORTCUT_UNSUPPORTED');
  if (!status.installed) return;
  if (context.platform === 'win32') {
    await fs.unlink(windowsLinkPath(identity, context));
    await fs.rm(windowsIconPath(identity, context), { force: true });
  } else if (context.platform === 'linux') {
    const paths = linuxPaths(identity, context);
    await fs.unlink(paths.desktop);
    await fs.rm(paths.script, { force: true });
    await fs.rm(paths.icon, { force: true });
  } else {
    await fs.rm(macPaths(identity, context).bundle, { recursive: true });
  }
}
