import { app, type WebContents } from 'electron';
import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import { log as loggerLog, warn as loggerWarn } from './logger';

const DEFAULT_DURATION_SECONDS = 60;
const MAX_DURATION_SECONDS = 60 * 60;
const DEFAULT_DELAY_SECONDS = 0;
const PROFILE_ARGUMENT = '--profile-renderer';
const PROFILE_DELAY_ARGUMENT = '--profile-renderer-delay';
const profiledContents = new WeakSet<WebContents>();

function parsePositiveSeconds(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') {
    return DEFAULT_DURATION_SECONDS;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.min(MAX_DURATION_SECONDS, Math.round(parsed));
}

export function rendererCpuProfileDurationSeconds(
  argv = process.argv
): number | null {
  const argument = argv.find(
    (value) =>
      value === PROFILE_ARGUMENT || value.startsWith(`${PROFILE_ARGUMENT}=`)
  );
  if (argument) {
    return parsePositiveSeconds(argument.split('=', 2)[1]);
  }
  return null;
}

function rendererCpuProfileDelaySeconds(
  argv = process.argv,
  environmentValue = process.env.QORTAL_RENDERER_PROFILE_DELAY_SECONDS
): number {
  const argument = argv.find((value) =>
    value.startsWith(`${PROFILE_DELAY_ARGUMENT}=`)
  );
  const raw = argument?.split('=', 2)[1] ?? environmentValue;
  if (raw === undefined) return DEFAULT_DELAY_SECONDS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_DELAY_SECONDS;
  return Math.min(MAX_DURATION_SECONDS, Math.round(parsed));
}

function safeLabel(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function maybeStartRendererCpuProfile(
  contents: WebContents,
  label: string
): void {
  const durationSeconds = rendererCpuProfileDurationSeconds();
  if (durationSeconds === null || profiledContents.has(contents)) return;
  profiledContents.add(contents);

  const delaySeconds = rendererCpuProfileDelaySeconds();
  loggerLog('[RendererProfile] capture scheduled', {
    label,
    webContentsId: contents.id,
    delaySeconds,
    durationSeconds,
  });

  void delay(delaySeconds * 1_000)
    .then(() => captureRendererCpuProfile(contents, label, durationSeconds))
    .catch((error) => {
      loggerWarn('[RendererProfile] capture failed', {
        label,
        webContentsId: contents.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

async function captureRendererCpuProfile(
  contents: WebContents,
  label: string,
  durationSeconds: number
): Promise<void> {
  if (contents.isDestroyed()) return;

  const debuggerClient = contents.debugger;
  if (debuggerClient.isAttached()) {
    throw new Error('Chromium debugger is already attached');
  }

  const startedAt = new Date();
  const timestamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const outputDirectory = path.join(
    app.getPath('userData'),
    'renderer-profiles'
  );
  const fileName = `${safeLabel(label) || 'renderer'}-${contents.id}-${timestamp}.cpuprofile`;
  const filePath = path.join(outputDirectory, fileName);

  try {
    debuggerClient.attach('1.3');
    await debuggerClient.sendCommand('Profiler.enable');
    await debuggerClient.sendCommand('Profiler.setSamplingInterval', {
      interval: 1_000,
    });
    await debuggerClient.sendCommand('Profiler.start');
    loggerLog('[RendererProfile] capture started', {
      label,
      webContentsId: contents.id,
      durationSeconds,
      filePath,
    });

    await delay(durationSeconds * 1_000);
    if (contents.isDestroyed() || !debuggerClient.isAttached()) {
      throw new Error('Renderer closed before the profile completed');
    }

    const result = (await debuggerClient.sendCommand('Profiler.stop')) as {
      profile?: unknown;
    };
    if (!result?.profile) throw new Error('Chromium returned no CPU profile');
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(filePath, JSON.stringify(result.profile), 'utf8');
    loggerLog('[RendererProfile] capture saved', {
      label,
      webContentsId: contents.id,
      durationSeconds,
      filePath,
    });
  } finally {
    if (debuggerClient.isAttached()) debuggerClient.detach();
  }
}
