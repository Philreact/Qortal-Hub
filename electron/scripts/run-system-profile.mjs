import { spawn, spawnSync } from 'node:child_process';
import { Buffer } from 'node:buffer';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import electronPath from 'electron';

if (process.platform !== 'linux') {
  console.error('System profiling is currently supported only on Linux.');
  process.exit(1);
}

class InspectorClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  connect() {
    return new Promise((resolvePromise, reject) => {
      this.socket = new WebSocket(this.url);
      this.socket.addEventListener('open', () => resolvePromise());
      this.socket.addEventListener('error', () =>
        reject(new Error(`Could not connect to ${this.url}`))
      );
      this.socket.addEventListener('message', (event) => {
        const message = JSON.parse(String(event.data));
        if (!message.id) return;
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result ?? {});
      });
    });
  }

  send(method, params = {}) {
    return new Promise((resolvePromise, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket?.close();
  }
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const electronDirectory = resolve(scriptDirectory, '..');
const repositoryDirectory = resolve(electronDirectory, '..');
const artifactRoot = join(repositoryDirectory, '.artifacts', 'system-profiles');
const toolVenv = join(
  repositoryDirectory,
  '.artifacts',
  'system-profiler-venv'
);
const pySpyPath = join(toolVenv, 'bin', 'py-spy');

const durationSeconds = positiveInteger(
  process.env.QORTAL_SYSTEM_PROFILE_SECONDS,
  300,
  3_600
);
const delaySeconds = positiveInteger(
  process.env.QORTAL_SYSTEM_PROFILE_DELAY_SECONDS,
  30,
  600
);
const timestamp = new Date().toISOString().replaceAll(':', '-');
const outputDirectory = join(artifactRoot, timestamp);
const forwardAppLogs = process.env.QORTAL_SYSTEM_PROFILE_FORWARD_LOGS === '1';
mkdirSync(outputDirectory, { recursive: true });

ensurePySpy();

const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
environment.QORTAL_SYSTEM_PROFILE_ATTACH_TIMEOUT_SECONDS = String(
  delaySeconds + durationSeconds + 60
);

const logCounts = new Map();
let captureLogs = false;
let inspectorUrl = null;
let bridgePid = null;
let stderrRemainder = '';
let stdoutRemainder = '';
let activePySpy = null;

const child = spawn(
  electronPath,
  ['--inspect=0', '.', `--profile-system=${durationSeconds}`],
  {
    cwd: electronDirectory,
    env: environment,
    stdio: ['inherit', 'pipe', 'pipe'],
  }
);

consumeOutput(child.stdout, forwardAppLogs ? process.stdout : null, 'stdout');
consumeOutput(child.stderr, forwardAppLogs ? process.stderr : null, 'stderr');

const earlyExit = new Promise((_, reject) => {
  child.once('exit', (code, signal) => {
    reject(
      new Error(
        `Electron exited before profiling completed (code=${code ?? 'none'}, signal=${signal ?? 'none'}). Close other Hub instances before starting a system profile.`
      )
    );
  });
});

try {
  await Promise.race([
    waitFor(() => {
      if (!bridgePid) {
        bridgePid = findDescendantPid(child.pid, 'presence_bridge.py');
      }
      return inspectorUrl && bridgePid;
    }, 120_000),
    earlyExit,
  ]);
  console.log(
    `[SystemProfile] waiting ${delaySeconds}s before a ${durationSeconds}s capture`
  );
  await Promise.race([delay(delaySeconds * 1_000), earlyExit]);

  const inspector = new InspectorClient(inspectorUrl);
  await inspector.connect();
  await inspector.send('Profiler.enable');
  await inspector.send('Profiler.setSamplingInterval', { interval: 1_000 });

  const bridgeProfilePath = join(
    outputDirectory,
    'presence-bridge.speedscope.json'
  );
  const pySpy = spawn(
    pySpyPath,
    [
      'record',
      '--pid',
      String(bridgePid),
      '--duration',
      String(durationSeconds),
      '--rate',
      '20',
      '--format',
      'speedscope',
      '--threads',
      '--nonblocking',
      '--output',
      bridgeProfilePath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  activePySpy = pySpy;
  pySpy.once('exit', () => {
    if (activePySpy === pySpy) activePySpy = null;
  });
  pySpy.stdout.pipe(process.stdout);
  pySpy.stderr.pipe(process.stderr);

  const samplesPath = join(outputDirectory, 'process-samples.jsonl');
  const sampler = startProcessSampler(child.pid, samplesPath);
  captureLogs = true;
  const captureStartedAt = new Date().toISOString();
  await inspector.send('Profiler.start');
  console.log('[SystemProfile] capture started', {
    mainPid: child.pid,
    bridgePid,
    durationSeconds,
    outputDirectory,
  });

  await Promise.race([delay(durationSeconds * 1_000), earlyExit]);
  const profileResult = await inspector.send('Profiler.stop');
  captureLogs = false;
  sampler.stop();
  inspector.close();

  const mainProfilePath = join(outputDirectory, 'electron-main.cpuprofile');
  writeFileSync(mainProfilePath, JSON.stringify(profileResult.profile));

  const pySpyResult = await waitForChild(pySpy, 15_000);
  let bridgeAttachPermissionRevoked = false;
  try {
    process.kill(bridgePid, 'SIGUSR2');
    bridgeAttachPermissionRevoked = true;
  } catch {
    // The timeout inside the bridge remains as the fallback.
  }
  const processSummary = sampler.summary();
  const summary = {
    captureStartedAt,
    captureFinishedAt: new Date().toISOString(),
    durationSeconds,
    delaySeconds,
    mainPid: child.pid,
    bridgePid,
    files: {
      mainCpuProfile: mainProfilePath,
      bridgeCpuProfile: existsSync(bridgeProfilePath)
        ? bridgeProfilePath
        : null,
      processSamples: samplesPath,
    },
    bridgeProfiler: pySpyResult,
    bridgeAttachPermissionRevoked,
    logCounts: Object.fromEntries(logCounts),
    logRates: {
      linesPerSecond: (logCounts.get('console.lines') ?? 0) / durationSeconds,
      bytesPerSecond: (logCounts.get('console.bytes') ?? 0) / durationSeconds,
    },
    processes: processSummary,
  };
  writeFileSync(
    join(outputDirectory, 'summary.json'),
    JSON.stringify(summary, null, 2)
  );
  console.log('[SystemProfile] capture saved', summary);
  console.log('[SystemProfile] Hub remains running normally.');
} catch (error) {
  console.error('[SystemProfile] capture failed:', error);
  child.kill('SIGTERM');
  process.exitCode = 1;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    activePySpy?.kill('SIGINT');
    const terminateSelf = () => process.kill(process.pid, signal);
    if (child.exitCode !== null || child.signalCode !== null) {
      terminateSelf();
      return;
    }
    child.once('exit', terminateSelf);
    child.kill(signal);
  });
}

function positiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), maximum);
}

function ensurePySpy() {
  if (existsSync(pySpyPath)) return;

  console.log('[SystemProfile] installing py-spy into .artifacts');
  runChecked('python3', ['-m', 'venv', toolVenv]);
  runChecked(join(toolVenv, 'bin', 'pip'), [
    'install',
    '--disable-pip-version-check',
    'py-spy==0.4.2',
  ]);
}

function runChecked(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status}`);
  }
}

function consumeOutput(stream, destination, source) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    destination?.write(chunk);
    if (source === 'stderr') {
      stderrRemainder = consumeLines(stderrRemainder + chunk);
    } else {
      stdoutRemainder = consumeLines(stdoutRemainder + chunk);
    }
  });
}

function consumeLines(value) {
  const lines = value.split(/\r?\n/);
  const remainder = lines.pop() ?? '';
  for (const line of lines) inspectLine(line);
  return remainder;
}

function inspectLine(line) {
  if (!inspectorUrl) {
    inspectorUrl =
      line.match(/Debugger listening on (ws:\/\/\S+)/)?.[1] ?? null;
  }
  if (!bridgePid) {
    const parsedPid = Number(
      line.match(/\[ReticulumBridge\] Spawned child pid=(\d+)/)?.[1]
    );
    if (Number.isInteger(parsedPid) && parsedPid > 0) bridgePid = parsedPid;
  }
  if (!captureLogs) return;

  increment('console.lines');
  increment('console.bytes', Buffer.byteLength(line, 'utf8') + 1);
  countWhen(
    line,
    '[Presence] Emitting update address=',
    'presence.managerUpdates'
  );
  countWhen(
    line,
    '[Presence] Broadcasting presence update from manager to renderer queue',
    'presence.forwardedUpdates'
  );
  countWhen(line, '[Presence] Flushing ', 'presence.ipcFlushes');
  countWhen(line, '[ReticulumBridge', 'bridge.lines');
  countWhen(line, '[ReticulumChat]', 'chat.lines');
  countWhen(line, 'overlay-link', 'bridge.overlayLinkLines');
  countWhen(line, 'resource_', 'bridge.resourceLines');
  countWhen(line, 'main-event-loop-stall', 'electron.mainStallLines');
}

function countWhen(line, fragment, key) {
  if (line.includes(fragment)) increment(key);
}

function increment(key, amount = 1) {
  logCounts.set(key, (logCounts.get(key) ?? 0) + amount);
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolvePromise();
      } else if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for Electron profiler readiness'));
      }
    }, 100);
    timer.unref?.();
  });
}

function findDescendantPid(rootPid, commandFragment) {
  const processes = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const fields = stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      const command = readFileSync(`/proc/${pid}/cmdline`)
        .toString('utf8')
        .replaceAll('\0', ' ')
        .trim();
      processes.push({ pid, parentPid: Number(fields[1]), command });
    } catch {
      // Processes can exit while /proc is being inspected.
    }
  }

  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of processes) {
      if (
        descendants.has(processInfo.parentPid) &&
        !descendants.has(processInfo.pid)
      ) {
        descendants.add(processInfo.pid);
        changed = true;
      }
    }
  }

  return (
    processes.find(
      ({ pid, command }) =>
        descendants.has(pid) && command.includes(commandFragment)
    )?.pid ?? null
  );
}

function delay(milliseconds) {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}

function waitForChild(processHandle, timeoutMs) {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve({
      code: processHandle.exitCode,
      signal: processHandle.signalCode,
    });
  }

  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => {
      processHandle.kill('SIGINT');
      resolvePromise({ code: null, signal: 'timeout' });
    }, timeoutMs);
    processHandle.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
  });
}

function startProcessSampler(rootPid, outputPath) {
  const previous = new Map();
  const aggregates = new Map();
  const clockTicks = Number(
    spawnSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).stdout.trim()
  );
  const pageSize = Number(
    spawnSync('getconf', ['PAGESIZE'], { encoding: 'utf8' }).stdout.trim()
  );

  const sample = () => {
    const sampledAt = Date.now();
    for (const processInfo of readProcessTree(rootPid, clockTicks, pageSize)) {
      const prior = previous.get(processInfo.pid);
      const elapsedSeconds = prior
        ? (sampledAt - prior.sampledAt) / 1_000
        : null;
      const cpuPercent =
        prior && elapsedSeconds > 0
          ? ((processInfo.cpuSeconds - prior.cpuSeconds) / elapsedSeconds) * 100
          : null;
      const readBytesDelta = counterDelta(
        processInfo.readBytes,
        prior?.readBytes
      );
      const writeBytesDelta = counterDelta(
        processInfo.writeBytes,
        prior?.writeBytes
      );
      previous.set(processInfo.pid, {
        sampledAt,
        cpuSeconds: processInfo.cpuSeconds,
        readBytes: processInfo.readBytes,
        writeBytes: processInfo.writeBytes,
      });
      const row = {
        sampledAt,
        ...processInfo,
        cpuPercent,
        readBytesDelta,
        writeBytesDelta,
      };
      appendFileSync(outputPath, `${JSON.stringify(row)}\n`);

      if (cpuPercent === null) continue;
      const aggregate = aggregates.get(processInfo.role) ?? {
        samples: 0,
        cpuPercentTotal: 0,
        cpuPercentMax: 0,
        rssBytesMax: 0,
        readBytes: 0,
        writeBytes: 0,
      };
      aggregate.samples += 1;
      aggregate.cpuPercentTotal += cpuPercent;
      aggregate.cpuPercentMax = Math.max(aggregate.cpuPercentMax, cpuPercent);
      aggregate.rssBytesMax = Math.max(
        aggregate.rssBytesMax,
        processInfo.rssBytes
      );
      aggregate.readBytes += readBytesDelta ?? 0;
      aggregate.writeBytes += writeBytesDelta ?? 0;
      aggregates.set(processInfo.role, aggregate);
    }
  };

  sample();
  const timer = setInterval(sample, 1_000);
  return {
    stop: () => clearInterval(timer),
    summary: () =>
      Object.fromEntries(
        [...aggregates.entries()].map(([role, value]) => [
          role,
          {
            ...value,
            cpuPercentAverage:
              value.samples > 0 ? value.cpuPercentTotal / value.samples : 0,
          },
        ])
      ),
  };
}

function readProcessTree(rootPid, clockTicks, pageSize) {
  const all = [];
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const closeParen = stat.lastIndexOf(')');
      const fields = stat
        .slice(closeParen + 2)
        .trim()
        .split(/\s+/);
      const command = readFileSync(`/proc/${pid}/cmdline`)
        .toString('utf8')
        .replaceAll('\0', ' ')
        .trim();
      const io = readProcIo(pid);
      all.push({
        pid,
        parentPid: Number(fields[1]),
        cpuSeconds: (Number(fields[11]) + Number(fields[12])) / clockTicks,
        rssBytes: Number(fields[21]) * pageSize,
        command,
        ...io,
      });
    } catch {
      // Processes can exit while /proc is being sampled.
    }
  }

  const included = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const processInfo of all) {
      if (
        included.has(processInfo.parentPid) &&
        !included.has(processInfo.pid)
      ) {
        included.add(processInfo.pid);
        changed = true;
      }
    }
  }

  return all
    .filter(({ pid }) => included.has(pid))
    .map((processInfo) => ({
      ...processInfo,
      role: processRole(processInfo, rootPid),
    }));
}

function readProcIo(pid) {
  const values = {};
  try {
    for (const line of readFileSync(`/proc/${pid}/io`, 'utf8').split('\n')) {
      const [key, value] = line.split(':');
      if (key && value) values[key.trim()] = Number(value.trim());
    }
  } catch {
    return { readBytes: null, writeBytes: null };
  }
  return {
    readBytes: values.read_bytes ?? null,
    writeBytes: values.write_bytes ?? null,
  };
}

function counterDelta(current, previous) {
  if (current === null || previous === null || previous === undefined) {
    return null;
  }
  return Math.max(0, current - previous);
}

function processRole(processInfo, rootPid) {
  const command = processInfo.command;
  if (processInfo.pid === rootPid) return 'electron-main';
  if (command.includes('presence_bridge.py')) return 'presence-bridge';
  if (command.includes('RNS.Utilities.rnsd')) return 'rnsd';
  if (command.includes('--type=renderer')) return 'electron-renderer';
  if (command.includes('--type=gpu-process')) return 'electron-gpu';
  if (command.includes('--type=utility')) return 'electron-utility';
  if (command.includes('--type=zygote')) return 'electron-zygote';
  return 'other';
}
