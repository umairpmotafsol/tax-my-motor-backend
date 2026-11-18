import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import sharp from 'sharp';

/** How long one read may take before the supplier is told to try again. */
const READ_TIMEOUT_MS = 30_000;

/**
 * The longest side, in pixels, a photo is read at.
 *
 * A phone photo is 12 megapixels or more, and the detector shrinks it to
 * well under 1000 px on its own anyway — handing it the full-size pixels
 * only costs memory (a 12 MP RGBA buffer is ~48 MB) and time. The VRM line
 * is large print on a receipt, so nothing legible is lost at this size.
 */
const MAX_SIDE_PX = 1024;

/**
 * ONNX Runtime settings, chosen by measurement (6 reads of a receipt and a
 * 3000 px version of it, peak process memory):
 *
 *   defaults                       ~900 MB   0.8-1.8 s   (would kill a dyno)
 *   arena off, no pattern          ~390 MB   2.7-4.5 s   (safe, slow)
 *   arena off, pattern on, 4 threads ~400 MB   0.8-1.3 s once warm, 2.5-3.5 s
 *                                              the first time a new image
 *                                              shape is seen  <- used
 *
 * The CPU memory arena is what balloons: it keeps every temporary buffer
 * the models ask for. Turning it off while keeping the memory-pattern
 * planner keeps the speed of a warm session at under half the memory.
 * Those figures include Node's own ~100 MB, on a 16-core machine.
 */
const ONNX_OPTIONS = {
  enableCpuMemArena: false,
  enableMemPattern: true,
  intraOpNumThreads: 4,
  interOpNumThreads: 1,
};

/** What the OCR library hands back for an image: one entry per printed line. */
interface PaddleResult {
  texts: Array<{ text: string; mean?: number }>;
}

interface PaddleOcr {
  detect(image: { data: Buffer; width: number; height: number }): Promise<PaddleResult>;
}

/**
 * `@gutenye/ocr-node` is an ES module, and this project compiles to
 * CommonJS, where TypeScript would turn `import()` into `require()` and
 * fail. Going through `Function` keeps it a real dynamic import.
 */
const importEsm = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<{ default: { create(options?: object): Promise<PaddleOcr> } }>;

/**
 * Reads the text off a photographed receipt with PaddleOCR (the PP-OCR
 * detection and recognition models, run through ONNX Runtime), entirely on
 * this server and with no API key, quota or network call.
 *
 * It replaced Tesseract. On the receipt this was built around, Tesseract
 * read the registration as "RJB3HXD" (the 6 as a B); PaddleOCR reads
 * "RJ63HXD", and does it in under a second where Tesseract took ~1.5 s.
 *
 * Memory is the cost: the loaded models and ONNX Runtime take roughly
 * 300 MB on top of the app (see ONNX_OPTIONS). They are loaded on the first receipt
 * rather than at boot, so an instance that never checks a receipt never
 * pays for it — but once loaded they stay until the process restarts.
 * A 512 MB dyno will run this tight; 1 GB is comfortable.
 *
 * One read at a time: the shared session is not worth the risk of
 * interleaving, and a short queue of supplier photos is cheaper than a
 * second copy of the models.
 */
@Injectable()
export class ReceiptOcrService {
  private readonly logger = new Logger(ReceiptOcrService.name);
  private engine: Promise<PaddleOcr> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  /** The text on the receipt, as one string with a line per printed line. */
  async readText(image: Buffer): Promise<string> {
    const job = this.queue.then(() => this.recognise(image));
    /* A failed read must not poison the queue for the next supplier. */
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async recognise(image: Buffer): Promise<string> {
    const engine = await this.start();

    /*
     * Decoded here, not left to the library: `.rotate()` applies the EXIF
     * orientation, so a photo a phone saved sideways is read upright, and
     * the resize keeps the pixel count bounded. A file sharp cannot decode
     * (HEIC, a truncated upload) throws, which the caller treats as "the
     * photo is the problem".
     */
    const { data, info } = await sharp(image)
      .rotate()
      .resize({ width: MAX_SIDE_PX, height: MAX_SIDE_PX, fit: 'inside', withoutEnlargement: true })
      .ensureAlpha(1)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const result = await Promise.race([
      engine.detect({ data, width: info.width, height: info.height }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out reading the receipt')), READ_TIMEOUT_MS).unref(),
      ),
    ]);
    return (result.texts ?? []).map(line => line.text).join('\n');
  }

  private start(): Promise<PaddleOcr> {
    if (!this.engine) {
      this.engine = importEsm('@gutenye/ocr-node')
        .then(module => module.default.create({ onnxOptions: ONNX_OPTIONS }))
        .catch(error => {
          this.engine = null;
          this.logger.error('Could not start the receipt reader: ' + (error as Error).message);
          throw new ServiceUnavailableException(
            'The receipt check is not available right now. Please try again.',
          );
        });
    }
    return this.engine;
  }
}
