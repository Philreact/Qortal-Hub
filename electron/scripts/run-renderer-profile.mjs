import { spawn } from 'node:child_process';
import electronPath from 'electron';

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

const durationSeconds = process.env.QORTAL_RENDERER_PROFILE_SECONDS || '900';
const delaySeconds = process.env.QORTAL_RENDERER_PROFILE_DELAY_SECONDS || '60';
const child = spawn(
  electronPath,
  [
    '--inspect=0',
    '.',
    '--new-instance',
    `--profile-renderer=${durationSeconds}`,
    `--profile-renderer-delay=${delaySeconds}`,
  ],
  {
    cwd: new URL('..', import.meta.url),
    env: environment,
    stdio: 'inherit',
  }
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => child.kill(signal));
}

child.once('error', (error) => {
  console.error('Could not start the renderer profiling instance:', error);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
