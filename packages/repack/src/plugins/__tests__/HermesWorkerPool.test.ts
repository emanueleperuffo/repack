import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { HermesWorkerPool } from '../HermesBytecodePlugin/utils/HermesWorkerPool.js';

class FakeWorker extends EventEmitter {
  jobs: Array<{ id: number; bundlePath: string }> = [];
  send = jest.fn((job: { id: number; bundlePath: string }) => {
    this.jobs.push(job);
  });
  disconnect = jest.fn();

  finish(result = { composedSourceMap: true }) {
    const { id } = this.jobs.shift()!;
    this.emit('message', { id, result });
  }

  fail(error: string) {
    const { id } = this.jobs.shift()!;
    this.emit('message', { id, error });
  }
}

function createPool(maxWorkers: number) {
  const workers: FakeWorker[] = [];
  const pool = new HermesWorkerPool({
    maxWorkers,
    forkWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as ChildProcess;
    },
  });
  return { pool, workers };
}

function job(bundlePath: string) {
  return {
    hermesCLIPath: 'path/to/hermesc',
    reactNativePath: 'path/to/react-native',
    bundlePath,
  };
}

describe('HermesWorkerPool', () => {
  it('starts workers on demand, up to maxWorkers', () => {
    const { pool, workers } = createPool(2);
    expect(workers).toHaveLength(0);

    pool.run(job('a.bundle'));
    pool.run(job('b.bundle'));
    pool.run(job('c.bundle'));

    expect(workers).toHaveLength(2);
    expect(workers[0].jobs.map(({ bundlePath }) => bundlePath)).toEqual([
      'a.bundle',
    ]);
    expect(workers[1].jobs.map(({ bundlePath }) => bundlePath)).toEqual([
      'b.bundle',
    ]);
  });

  it('hands queued jobs to workers as they become idle', async () => {
    const { pool, workers } = createPool(1);

    const first = pool.run(job('a.bundle'));
    const second = pool.run(job('b.bundle'));
    expect(workers[0].send).toHaveBeenCalledTimes(1);

    workers[0].finish();
    await expect(first).resolves.toEqual({ composedSourceMap: true });
    expect(workers[0].send).toHaveBeenCalledTimes(2);

    workers[0].finish({ composedSourceMap: false });
    await expect(second).resolves.toEqual({ composedSourceMap: false });
    expect(workers).toHaveLength(1);
  });

  it('rejects a job that fails and keeps the worker', async () => {
    const { pool, workers } = createPool(1);

    const failing = pool.run(job('a.bundle'));
    const next = pool.run(job('b.bundle'));

    workers[0].fail('hermesc failed');
    await expect(failing).rejects.toThrow('hermesc failed');

    workers[0].finish();
    await expect(next).resolves.toEqual({ composedSourceMap: true });
    expect(workers).toHaveLength(1);
  });

  it('rejects the running job when its worker exits and replaces the worker', async () => {
    const { pool, workers } = createPool(1);

    const lost = pool.run(job('a.bundle'));
    const queued = pool.run(job('b.bundle'));

    workers[0].emit('exit', 1);
    await expect(lost).rejects.toThrow('Hermes worker exited with code 1');

    expect(workers).toHaveLength(2);
    workers[1].finish();
    await expect(queued).resolves.toEqual({ composedSourceMap: true });
  });

  it('disconnects every worker on close', () => {
    const { pool, workers } = createPool(2);
    pool.run(job('a.bundle'));
    pool.run(job('b.bundle'));

    pool.close();

    for (const worker of workers) {
      expect(worker.disconnect).toHaveBeenCalledTimes(1);
    }
  });

  it('rejects queued jobs on close and starts no workers afterwards', async () => {
    const { pool, workers } = createPool(1);
    const running = pool.run(job('a.bundle'));
    const queued = pool.run(job('b.bundle'));

    pool.close();
    workers[0].emit('exit', 0);

    await expect(queued).rejects.toThrow('Hermes worker pool is closed');
    await expect(running).rejects.toThrow('Hermes worker exited with code 0');
    await expect(pool.run(job('c.bundle'))).rejects.toThrow(
      'Hermes worker pool is closed'
    );
    expect(workers).toHaveLength(1);
  });
});
