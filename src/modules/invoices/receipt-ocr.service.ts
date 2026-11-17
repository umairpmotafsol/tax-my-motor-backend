import { Injectable, Logger, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { createWorker, Worker } from 'tesseract.js';

/** How long one read may take before the supplier is told to try again. */
const READ_TIMEOUT_MS = 30_000;

/**
 * The worker holds a few hundred MB while it is alive, which matters on a
 * small dyno. Receipts arrive in bursts, so it is kept warm for a while
 * and then let go; the next read pays the few seconds to start it again.
 */
const IDLE_MS = 5 * 60_000;

/**
 * Reads the text off a photographed receipt with Tesseract (tesseract.js,
 * the JavaScript build), entirely on this server.
 *
 * The English language data comes from the `@tesseract.js-data/eng`
 * package rather than being fetched from a CDN the first time it is
 * needed, so a read never depends on a third party being reachable and a
 * fresh dyno does not download 10 MB before its first answer.
 *
 * One worker, one job at a time: a worker is not safe to share between
 * concurrent recognitions, and a queue of a few supplier photos is
 * cheaper than a worker (and its memory) each.
 */
@Injectable()
export class ReceiptOcrService implements OnModuleDestroy {
  private readonly logger = new Logger(ReceiptOcrService.name);
  private worker: Promise<Worker> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;

  /** The text on the receipt, as one string with a line per printed line. */
  async readText(image: Buffer): Promise<string> {
    const job = this.queue.then(() => this.recognise(image));
    /* A failed read must not poison the queue for the next supplier. */
    this.queue = job.catch(() => undefined);
    return job;
  }

  async onModuleDestroy(): Promise<void> {
    await this.release();
  }

  private async recognise(image: Buffer): Promise<string> {
    this.clearIdle();
    const worker = await this.start();
    try {
      const result = await Promise.race([
        worker.recognize(image),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Timed out reading the receipt')), READ_TIMEOUT_MS).unref(),
        ),
      ]);
      return result.data.text ?? '';
    } catch (error) {
      /* A worker that timed out may still be busy; start fresh next time. */
      await this.release();
      throw error;
    } finally {
      this.armIdle();
    }
  }

  private start(): Promise<Worker> {
    if (!this.worker) {
      const langPath = join(
        dirname(require.resolve('@tesseract.js-data/eng/package.json')),
        '4.0.0_best_int',
      );
      this.worker = createWorker('eng', 1, {
        langPath,
        gzip: true,
        /* The default is the working directory, which a dyno may not own. */
        cachePath: tmpdir(),
      }).catch(error => {
        this.worker = null;
        this.logger.error('Could not start the receipt reader: ' + (error as Error).message);
        throw new ServiceUnavailableException('The receipt check is not available right now. Please try again.');
      });
    }
    return this.worker;
  }

  private async release(): Promise<void> {
    this.clearIdle();
    const current = this.worker;
    this.worker = null;
    if (current) {
      try {
        await (await current).terminate();
      } catch {
        /* Already gone. */
      }
    }
  }

  private armIdle(): void {
    this.idleTimer = setTimeout(() => void this.release(), IDLE_MS);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
