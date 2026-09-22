import { spawn } from 'child_process';
import { qAppShortcutLaunchArgument } from './qapp-shortcuts';
import type { QAppLaunch } from './qapp-launch';

export function hubInstanceSpawnSpec(options: {
  execPath: string;
  appPath: string;
  packaged: boolean;
  appImagePath?: string;
  app?: QAppLaunch;
}): { executable: string; args: string[] } {
  const executable =
    options.packaged && options.appImagePath
      ? options.appImagePath
      : options.execPath;
  const args = [
    ...(options.packaged ? [] : [options.appPath]),
    '--new-instance',
    ...(options.app ? [qAppShortcutLaunchArgument(options.app)] : []),
  ];
  return { executable, args };
}

export async function spawnHubInstance(
  options: Parameters<typeof hubInstanceSpawnSpec>[0]
): Promise<void> {
  const { executable, args } = hubInstanceSpawnSpec(options);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    env,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', () => resolve());
    child.once('error', reject);
  });
  child.unref();
}
