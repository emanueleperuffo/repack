import { type ChildProcess, fork } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { HermesJob, HermesJobResult } from './runHermesJob.js';

type WorkerMessage =
  | { id: number; result: HermesJobResult }
  | { id: number; error: string };

interface PendingJob {
  job: HermesJob & { id: number };
  resolve: (result: HermesJobResult) => void;
  reject: (error: Error) => void;
}

/**
 * {@link HermesWorkerPool} options.
 */
export interface HermesWorkerPoolOptions {
  /** Maximum number of worker processes. Defaults to the number of available CPUs. */
  maxWorkers?: number;

  /** Starts a worker process. Defaults to forking `hermesWorker.js`. */
  forkWorker?: () => ChildProcess;
}

/**
 * Runs {@link HermesJob}s in a pool of small worker processes.
 *
 * Spawning hermesc for every chunk straight from the bundler process is slow on Linux:
 * each spawn copies the page tables of the bundler's whole heap, so spawning thousands
 * of processes from a multi-gigabyte heap serializes into minutes. Workers start small,
 * so spawning from them stays cheap, and the pool caps how many run at once.
 *
 * Workers are started on demand, so a build without jobs starts none.
 */
export class HermesWorkerPool {
  readonly maxWorkers: number;

  private forkWorker: () => ChildProcess;
  private workers = new Set<ChildProcess>();
  private idleWorkers: ChildProcess[] = [];
  private queue: PendingJob[] = [];
  private running = new Map<number, PendingJob & { worker: ChildProcess }>();
  private nextJobId = 0;
  private closed = false;

  constructor({ maxWorkers, forkWorker }: HermesWorkerPoolOptions = {}) {
    this.maxWorkers = maxWorkers ?? getAvailableParallelism();
    this.forkWorker =
      forkWorker ?? (() => fork(path.join(__dirname, 'hermesWorker.js')));
  }

  /** Queues a job and resolves once a worker has finished it. */
  run(job: HermesJob): Promise<HermesJobResult> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(createClosedError());
        return;
      }

      this.queue.push({
        job: { ...job, id: this.nextJobId++ },
        resolve,
        reject,
      });
      this.dispatch();
    });
  }

  /**
   * Stops all worker processes and rejects the jobs still queued.
   *
   * Jobs that are already running are rejected once their worker exits.
   */
  close() {
    this.closed = true;

    for (const { reject } of this.queue) {
      reject(createClosedError());
    }
    this.queue = [];

    for (const worker of this.workers) {
      worker.disconnect();
    }
    this.workers.clear();
    this.idleWorkers = [];
  }

  private dispatch() {
    while (!this.closed && this.queue.length > 0) {
      const worker = this.idleWorkers.pop() ?? this.startWorker();
      if (!worker) {
        return;
      }

      const pendingJob = this.queue.shift()!;
      this.running.set(pendingJob.job.id, { ...pendingJob, worker });
      worker.send(pendingJob.job);
    }
  }

  private startWorker(): ChildProcess | undefined {
    if (this.workers.size >= this.maxWorkers) {
      return undefined;
    }

    const worker = this.forkWorker();
    this.workers.add(worker);

    worker.on('message', (message: WorkerMessage) => {
      const runningJob = this.running.get(message.id);
      if (!runningJob) {
        return;
      }

      this.running.delete(message.id);
      this.idleWorkers.push(worker);

      if ('error' in message) {
        runningJob.reject(new Error(message.error));
      } else {
        runningJob.resolve(message.result);
      }

      this.dispatch();
    });

    worker.on('exit', (code) => {
      this.workers.delete(worker);
      this.idleWorkers = this.idleWorkers.filter((idle) => idle !== worker);

      for (const [id, runningJob] of this.running) {
        if (runningJob.worker === worker) {
          this.running.delete(id);
          runningJob.reject(
            new Error(
              `[RepackHermesBytecodePlugin] Hermes worker exited with code ${code}`
            )
          );
        }
      }

      // Replace the lost worker for jobs that are still queued.
      this.dispatch();
    });

    return worker;
  }
}

function createClosedError() {
  return new Error('[RepackHermesBytecodePlugin] Hermes worker pool is closed');
}

function getAvailableParallelism() {
  // `os.availableParallelism` respects CPU quotas in containers, but needs Node 18.14.
  return os.availableParallelism?.() ?? os.cpus().length;
}
