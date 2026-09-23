import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import { extname, join, resolve } from 'path';

export interface StoredFile {
  fileName: string;
  storageKey: string;
  /** The hosted copy. Empty for a file kept on the local disk. */
  url: string;
  provider: 'local' | 'cloudinary';
  mimeType: string;
  size: number;
}

const EXTENSION_FOR: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/webp': '.webp',
};

/**
 * Where invoice photos live.
 *
 * Two stores, chosen by whether CLOUDINARY_URL is set.
 *
 * Cloudinary is the one that matters, because of where the photo has to
 * end up: an admin sends the invoice to the customer over WhatsApp, and
 * WhatsApp fetches a link with no bearer token and no cookie. An
 * authenticated API route cannot be the customer's copy — it would
 * arrive as a 401. So a sent invoice needs a hosted URL, and that is
 * what this returns.
 *
 * The local disk stays as the fallback, so a checkout with no Cloudinary
 * credentials still runs end to end. It is a development store only: the
 * disk is empty after a redeploy and is not shared between instances.
 *
 * Everything outside this class deals in a `storageKey` and a `url`, so
 * moving to a third store is a change here and nowhere else.
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);
  private readonly hosted: boolean;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('cloudinary.url') ?? '';
    this.hosted = url.length > 0;

    if (this.hosted) {
      /*
       * The SDK reads CLOUDINARY_URL from the environment on its own,
       * but only the environment — passing it explicitly keeps the
       * config module as the single place a setting comes from.
       */
      const { key, secret, cloud } = parseCloudinaryUrl(url);
      cloudinary.config({ cloud_name: cloud, api_key: key, api_secret: secret, secure: true });
      this.logger.log('Invoice photos will be stored on Cloudinary (' + cloud + ')');
    } else {
      this.logger.warn(
        'CLOUDINARY_URL is not set — invoice photos will be written to ' +
          this.root +
          '. They will not survive a redeploy, and an admin cannot send them to a customer.',
      );
    }
  }

  private get root(): string {
    return resolve(this.config.get<string>('uploadDir') ?? './uploads');
  }

  private get folder(): string {
    return this.config.get<string>('cloudinary.folder') ?? 'taxmymotor/invoices';
  }

  /**
   * Stores the upload under a name this service chooses.
   *
   * The client's filename is never used as a path — it is attacker
   * input, and "../../.env" is a filename. It survives only as the
   * download name, and even then only as an extension we recognise.
   */
  async store(orderNumber: string, file: Express.Multer.File): Promise<StoredFile> {
    const ext = EXTENSION_FOR[file.mimetype] ?? safeExtension(file.originalname);
    const safeOrder = orderNumber.replace(/[^A-Za-z0-9_-]/g, '');
    /*
     * Sixteen random hex characters on the end. The hosted URL is
     * unauthenticated by necessity, so the id is the only thing standing
     * between one customer's invoice and another's — "ORD-1027.jpg"
     * would be a guess away.
     */
    const key = safeOrder + '-' + randomBytes(8).toString('hex');
    const fileName = 'invoice-' + safeOrder + ext;

    return this.hosted
      ? this.toCloudinary(key, fileName, file)
      : this.toDisk(key + ext, fileName, file);
  }

  private async toCloudinary(
    key: string,
    fileName: string,
    file: Express.Multer.File,
  ): Promise<StoredFile> {
    const uploaded = await new Promise<UploadApiResponse>((done, fail) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: this.folder,
          public_id: key,
          resource_type: 'image',
          /*
           * HEIC off an iPhone is not a format a browser or WhatsApp
           * will render, so Cloudinary converts on the way in and the
           * stored copy is a JPEG whatever the camera produced.
           */
          format: 'jpg',
          overwrite: false,
        },
        (error, result) => (result ? done(result) : fail(error)),
      );
      stream.end(file.buffer);
    }).catch((error: unknown) => {
      this.logger.error('Cloudinary rejected the invoice upload', error as Error);
      throw new InternalServerErrorException('The invoice could not be saved. Please try again.');
    });

    return {
      fileName: fileName.replace(/\.[^.]+$/, '.jpg'),
      storageKey: uploaded.public_id,
      url: uploaded.secure_url,
      provider: 'cloudinary',
      mimeType: 'image/jpeg',
      size: uploaded.bytes ?? file.size,
    };
  }

  private async toDisk(
    key: string,
    fileName: string,
    file: Express.Multer.File,
  ): Promise<StoredFile> {
    const target = join(this.root, key);
    try {
      await fs.mkdir(this.root, { recursive: true });
      await fs.writeFile(target, file.buffer);
    } catch (error) {
      this.logger.error('Could not write invoice upload', error as Error);
      throw new InternalServerErrorException('The invoice could not be saved. Please try again.');
    }

    return {
      fileName,
      storageKey: key,
      url: '',
      provider: 'local',
      mimeType: file.mimetype,
      size: file.size,
    };
  }

  /** Deletes from whichever store holds it. Never throws. */
  async remove(storageKey: string, provider: 'local' | 'cloudinary' = 'local'): Promise<void> {
    if (provider === 'cloudinary') {
      await cloudinary.uploader
        .destroy(storageKey, { resource_type: 'image' })
        .catch((error: unknown) =>
          this.logger.warn('Could not delete ' + storageKey + ' from Cloudinary: ' + String(error)),
        );
      return;
    }
    await fs.unlink(join(this.root, storageKey)).catch(() => undefined);
  }
}

/** `cloudinary://<api_key>:<api_secret>@<cloud_name>` */
export function parseCloudinaryUrl(url: string): { key: string; secret: string; cloud: string } {
  const match = /^cloudinary:\/\/([^:]+):([^@]+)@([\w-]+)$/.exec(url.trim());
  if (!match) {
    throw new Error(
      'CLOUDINARY_URL is malformed. It looks like cloudinary://<api_key>:<api_secret>@<cloud_name>.',
    );
  }
  return { key: match[1], secret: match[2], cloud: match[3] };
}

function safeExtension(originalName: string): string {
  const ext = extname(originalName ?? '').toLowerCase();
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.jpg';
}
