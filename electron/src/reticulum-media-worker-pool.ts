import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { error as loggerError, warn as loggerWarn } from './logger';
import type {
  ReticulumMediaWorkerResult,
  ReticulumMediaWorkerTask,
  ReticulumMediaWorkerTaskInput,
} from './reticulum-media.worker';

const WORKER_FILENAME = 'reticulum-media.worker.js';
const MAX_QUEUED_TASKS = 3;
const TASK_TIMEOUT_MS = 2 * 60_000;

type QueueEntry = {
  task: ReticulumMediaWorkerTask;
  resolve: (result: ReticulumMediaWorkerResult | null) => void;
};

function resolveWorkerPath(): string {
  if (__dirname.includes('app.asar')) {
    const unpacked = __dirname.replace(
      /app\.asar(\/|\\)/,
      'app.asar.unpacked$1'
    );
    const unpackedPath = path.join(unpacked, WORKER_FILENAME);
    if (fs.existsSync(unpackedPath)) return unpackedPath;
  }
  const adjacent = path.join(__dirname, WORKER_FILENAME);
  if (fs.existsSync(adjacent)) return adjacent;
  const development = path.join(
    __dirname,
    '..',
    'build',
    'src',
    WORKER_FILENAME
  );
  return fs.existsSync(development) ? development : adjacent;
}

export class ReticulumMediaWorkerPool {
  private worker: Worker | null = null;
  private queue: QueueEntry[] = [];
  private active: QueueEntry | null = null;
  private activeTimeout: ReturnType<typeof setTimeout> | null = null;
  private nextId = 0;
  private stopping = false;

  run(
    input: ReticulumMediaWorkerTaskInput
  ): Promise<ReticulumMediaWorkerResult | null> {
    if (
      this.stopping ||
      this.queue.length + (this.active ? 1 : 0) >= MAX_QUEUED_TASKS
    ) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      this.queue.push({
        task: { ...input, id: ++this.nextId },
        resolve,
      });
      this.pump();
    });
  }

  stop(): void {
    this.stopping = true;
    if (this.activeTimeout) clearTimeout(this.activeTimeout);
    this.activeTimeout = null;
    this.active?.resolve(null);
    this.active = null;
    for (const entry of this.queue) entry.resolve(null);
    this.queue = [];
    this.worker?.removeAllListeners();
    void this.worker?.terminate();
    this.worker = null;
  }

  private ensureWorker(): Worker | null {
    if (this.worker) return this.worker;
    try {
      const worker = new Worker(resolveWorkerPath(), { execArgv: [] });
      worker.on('message', (result: ReticulumMediaWorkerResult) => {
        const entry = this.active;
        if (!entry || entry.task.id !== result.id) return;
        this.active = null;
        if (this.activeTimeout) clearTimeout(this.activeTimeout);
        this.activeTimeout = null;
        entry.resolve(result);
        this.pump();
      });
      worker.on('error', (error) => {
        loggerError('[ReticulumMediaWorker] worker_error', error);
      });
      worker.on('exit', (code) => {
        if (this.worker === worker) this.worker = null;
        const entry = this.active;
        this.active = null;
        if (this.activeTimeout) clearTimeout(this.activeTimeout);
        this.activeTimeout = null;
        if (entry) entry.resolve(null);
        if (code !== 0 && !this.stopping) {
          loggerWarn(`[ReticulumMediaWorker] worker_exit code=${code}`);
        }
        if (!this.stopping) this.pump();
      });
      this.worker = worker;
      return worker;
    } catch (error) {
      loggerError('[ReticulumMediaWorker] worker_start_failed', error);
      return null;
    }
  }

  private pump(): void {
    if (this.stopping || this.active || this.queue.length === 0) return;
    const entry = this.queue.shift();
    if (!entry) return;
    const worker = this.ensureWorker();
    if (!worker) {
      entry.resolve(null);
      this.pump();
      return;
    }
    this.active = entry;
    this.activeTimeout = setTimeout(() => {
      if (this.active !== entry) return;
      this.active = null;
      this.activeTimeout = null;
      loggerWarn('[ReticulumMediaWorker] gif_conversion_timeout');
      const timedOutWorker = this.worker;
      timedOutWorker?.removeAllListeners();
      void timedOutWorker?.terminate();
      this.worker = null;
      entry.resolve(null);
      this.pump();
    }, TASK_TIMEOUT_MS);
    this.activeTimeout.unref?.();
    try {
      worker.postMessage(entry.task);
    } catch (error) {
      this.active = null;
      if (this.activeTimeout) clearTimeout(this.activeTimeout);
      this.activeTimeout = null;
      loggerWarn('[ReticulumMediaWorker] post_failed', error);
      entry.resolve(null);
      this.pump();
    }
  }
}

export const reticulumMediaWorkerPool = new ReticulumMediaWorkerPool();
