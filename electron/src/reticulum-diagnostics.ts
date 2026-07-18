import type { WebContents } from 'electron';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const DEFAULT_CAPTURE_MS = 10_000;
const MIN_CAPTURE_MS = 3_000;
const MAX_CAPTURE_MS = 15_000;

type CpuProfileNode = {
  id?: number;
  callFrame?: {
    functionName?: string;
    url?: string;
    lineNumber?: number;
  };
};

type CpuProfile = {
  nodes?: CpuProfileNode[];
  samples?: number[];
};

export type ReticulumRendererProfileResult = {
  success: boolean;
  error?: string;
  durationMs?: number;
  profilePath?: string;
  sampleCount?: number;
  hotspots?: Array<{ label: string; samples: number }>;
};

let captureInProgress = false;

function normalizeDuration(value: unknown): number {
  const duration = Number(value);
  if (!Number.isFinite(duration)) return DEFAULT_CAPTURE_MS;
  return Math.min(MAX_CAPTURE_MS, Math.max(MIN_CAPTURE_MS, Math.round(duration)));
}

function summarizeProfile(profile: CpuProfile): Array<{ label: string; samples: number }> {
  const nodesById = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes || []) {
    if (typeof node.id === 'number') nodesById.set(node.id, node);
  }

  const samplesByLabel = new Map<string, number>();
  for (const sampleId of profile.samples || []) {
    const frame = nodesById.get(sampleId)?.callFrame;
    const url = frame?.url || '';
    const fileName = url.split('/').pop() || url || '<native>';
    const functionName = frame?.functionName || '<anonymous>';
    const lineNumber =
      typeof frame?.lineNumber === 'number' ? ':' + (frame.lineNumber + 1) : '';
    const label = fileName + ':' + functionName + lineNumber;
    samplesByLabel.set(label, (samplesByLabel.get(label) || 0) + 1);
  }

  return [...samplesByLabel.entries()]
    .map(([label, samples]) => ({ label, samples }))
    .sort((a, b) => b.samples - a.samples)
    .slice(0, 25);
}

export async function captureReticulumRendererCpuProfile(
  webContents: WebContents,
  userDataPath: string,
  requestedDurationMs?: unknown
): Promise<ReticulumRendererProfileResult> {
  if (captureInProgress) {
    return { success: false, error: 'A renderer CPU capture is already running.' };
  }
  if (webContents.isDestroyed()) {
    return { success: false, error: 'The chat renderer is no longer available.' };
  }
  if (webContents.debugger.isAttached()) {
    return {
      success: false,
      error: 'The renderer debugger is already attached. Close DevTools or finish its profile first.',
    };
  }

  const durationMs = normalizeDuration(requestedDurationMs);
  let profilerStarted = false;
  captureInProgress = true;

  try {
    webContents.debugger.attach('1.3');
    await webContents.debugger.sendCommand('Profiler.enable');
    await webContents.debugger.sendCommand('Profiler.start');
    profilerStarted = true;
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    const result = (await webContents.debugger.sendCommand('Profiler.stop')) as {
      profile?: CpuProfile;
    };
    profilerStarted = false;
    const profile = result.profile || {};
    const diagnosticsDir = join(userDataPath, 'reticulum-diagnostics');
    mkdirSync(diagnosticsDir, { recursive: true });
    const profilePath = join(
      diagnosticsDir,
      'renderer-cpu-' + new Date().toISOString().replace(/[:.]/g, '-') + '.cpuprofile'
    );
    writeFileSync(profilePath, JSON.stringify(profile));

    return {
      success: true,
      durationMs,
      profilePath,
      sampleCount: profile.samples?.length || 0,
      hotspots: summarizeProfile(profile),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Renderer CPU capture failed.',
    };
  } finally {
    if (profilerStarted) {
      try {
        await webContents.debugger.sendCommand('Profiler.stop');
      } catch {
        // The debugger can detach while the renderer is being reloaded.
      }
    }
    if (!webContents.isDestroyed() && webContents.debugger.isAttached()) {
      try {
        webContents.debugger.detach();
      } catch {
        // Detaching is best-effort when Electron is shutting down.
      }
    }
    captureInProgress = false;
  }
}
