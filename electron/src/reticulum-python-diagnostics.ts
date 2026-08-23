import { app } from 'electron';
import * as path from 'path';

function diagnosticsEnabled(env: NodeJS.ProcessEnv): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    String(env.QORTAL_PYTHON_DIAGNOSTICS ?? '')
      .trim()
      .toLowerCase()
  );
}

function diagnosticsResourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'reticulum')
    : path.join(__dirname, '..', '..', 'resources');
}

function prependPythonPath(directory: string, existing?: string): string {
  const entries = String(existing ?? '')
    .split(path.delimiter)
    .filter(Boolean);
  return [directory, ...entries.filter((entry) => entry !== directory)].join(
    path.delimiter
  );
}

/**
 * Adds the early Python diagnostics hook only for an explicitly enabled run.
 * With diagnostics disabled, the child environment is returned unchanged.
 */
export function withReticulumPythonDiagnostics(
  env: NodeJS.ProcessEnv,
  processName: 'presence-bridge' | 'rnsd',
  configDir: string
): NodeJS.ProcessEnv {
  if (!diagnosticsEnabled(env)) return env;

  const resourceDir = diagnosticsResourceDir();
  return {
    ...env,
    PYTHONPATH: prependPythonPath(resourceDir, env.PYTHONPATH),
    QORTAL_PYTHON_DIAGNOSTICS_PROCESS: processName,
    QORTAL_PYTHON_DIAGNOSTICS_DIR:
      env.QORTAL_PYTHON_DIAGNOSTICS_DIR ??
      path.join(configDir, 'python-diagnostics'),
  };
}
