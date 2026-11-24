/**
 * Entry point of a {@link HermesWorkerPool} worker process.
 *
 * Receives one {@link HermesJob} at a time from the parent process and replies with
 * its result or error, tagged with the job's id.
 */
import { type HermesJob, runHermesJob } from './runHermesJob.js';

process.on('message', async ({ id, ...job }: HermesJob & { id: number }) => {
  try {
    const result = await runHermesJob(job);
    process.send?.({ id, result });
  } catch (error) {
    process.send?.({ id, error: (error as Error).message });
  }
});

// Exit together with the parent instead of lingering when the build ends or crashes.
process.on('disconnect', () => process.exit(0));
