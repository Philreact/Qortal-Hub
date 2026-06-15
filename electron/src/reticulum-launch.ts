import { error as loggerError, log as loggerLog } from './logger';
import {
  getReticulumDaemonStatus,
  isReticulumSharedDaemonOwnedByAnotherLiveInstance,
  restartBundledReticulumDaemonAndWaitReady,
  startBundledReticulumDaemon,
  waitForReticulumSharedInstanceReady,
} from './reticulum-daemon';
import { startReticulumBridge, stopReticulumBridge } from './reticulum-bridge';

const RETICULUM_EXISTING_SHARED_PREFLIGHT_MS = 750;

async function tryStartBridgeWithExistingSharedInstance(
  timeoutMs?: number
): Promise<boolean> {
  const preflightTimeoutMs = Math.min(
    timeoutMs ?? RETICULUM_EXISTING_SHARED_PREFLIGHT_MS,
    RETICULUM_EXISTING_SHARED_PREFLIGHT_MS
  );
  try {
    await waitForReticulumSharedInstanceReady(preflightTimeoutMs);
  } catch {
    return false;
  }

  try {
    loggerLog(
      '[Reticulum] Existing shared instance is reachable; starting bridge without spawning rnsd.'
    );
    await startReticulumBridge();
    return true;
  } catch (bridgeError) {
    stopReticulumBridge();
    if (isReticulumSharedDaemonOwnedByAnotherLiveInstance()) {
      loggerError(
        '[Reticulum] Existing shared instance is owned by another live app instance, but bridge startup failed:',
        bridgeError
      );
      return true;
    }
    loggerError(
      '[Reticulum] Bridge startup failed with existing shared instance; restarting rnsd:',
      bridgeError
    );
    await restartBundledReticulumDaemonAndWaitReady(timeoutMs, {
      forceKillOnStopTimeout: true,
    });
    await waitForReticulumSharedInstanceReady(timeoutMs);
    await startReticulumBridge();
    return true;
  }
}

async function waitForAnyReticulumReadiness(timeoutMs?: number): Promise<void> {
  try {
    await waitForReticulumSharedInstanceReady(timeoutMs);
  } catch (sharedError) {
    if (isReticulumSharedDaemonOwnedByAnotherLiveInstance()) {
      loggerLog(
        '[Reticulum] Shared instance readiness failed during launch, but another live app instance owns rnsd; starting bridge without restarting daemon:',
        sharedError
      );
      await startReticulumBridge();
      return;
    }
    try {
      loggerLog(
        '[Reticulum] Shared instance readiness failed during launch; trying bridge before restarting rnsd:',
        sharedError
      );
      await startReticulumBridge();
      return;
    } catch (bridgeError) {
      loggerError(
        '[Reticulum] Bridge startup failed after shared readiness timeout; restarting rnsd:',
        bridgeError
      );
      stopReticulumBridge();
    }
    await restartBundledReticulumDaemonAndWaitReady(timeoutMs, {
      forceKillOnStopTimeout: true,
    });
    try {
      await waitForReticulumSharedInstanceReady(timeoutMs);
    } catch (restartError) {
      loggerError(
        '[Reticulum] Shared instance readiness failed after launch restart:',
        restartError
      );
      throw restartError;
    }
  }
  await startReticulumBridge();
}

export async function startReticulumForAppLaunch(
  timeoutMs?: number
): Promise<void> {
  try {
    if (await tryStartBridgeWithExistingSharedInstance(timeoutMs)) {
      return;
    }
  } catch (error) {
    loggerError(
      '[Reticulum] Existing shared instance recovery failed; skipping daemon spawn to avoid splitting shared rnsd:',
      error
    );
    return;
  }

  startBundledReticulumDaemon();

  const status = getReticulumDaemonStatus();
  if (!status.running) {
    return;
  }

  try {
    await waitForAnyReticulumReadiness(timeoutMs);
  } catch (error) {
    loggerError(
      '[Reticulum] Launch readiness wait failed; continuing with bridge startup:',
      error
    );
  }
}
