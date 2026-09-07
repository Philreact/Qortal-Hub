#!/usr/bin/env node
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const electronRoot = path.resolve(scriptDir, '..');
const moduleRoot = path.join(electronRoot, 'native', 'private-transport');
const go = process.env.QORTAL_GO_BINARY || 'go';
const goos =
  process.env.QORTAL_PRIVATE_TRANSPORT_GOOS ||
  (process.platform === 'win32'
    ? 'windows'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux');
const goarch =
  process.env.QORTAL_PRIVATE_TRANSPORT_GOARCH ||
  (process.arch === 'arm64' ? 'arm64' : 'amd64');
const packageArch = goarch === 'amd64' ? 'x64' : goarch;
const outputDir = path.join(
  electronRoot,
  'resources',
  'private-transport',
  `${goos}-${packageArch}`
);
const output = path.join(
  outputDir,
  `qortal-private-transport${goos === 'windows' ? '.exe' : ''}`
);

fs.mkdirSync(outputDir, { recursive: true });
const result = spawnSync(
  go,
  [
    'build',
    '-trimpath',
    '-ldflags=-s -w',
    '-o',
    output,
    './cmd/qortal-private-transport',
  ],
  {
    cwd: moduleRoot,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, GOOS: goos, GOARCH: goarch, CGO_ENABLED: '0' },
  }
);
if (result.error) {
  console.error(`Unable to run Go compiler (${go}):`, result.error.message);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);
if (goos !== 'windows') fs.chmodSync(output, 0o755);
console.log(`Built ${output}`);
