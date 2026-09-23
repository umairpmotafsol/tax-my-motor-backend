import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { InvoicesService, parseCloudinaryUrl } from './invoices.service';

/**
 * Which store an invoice photo goes to, and what comes back.
 *
 * The return value is the contract the rest of the system reads: the
 * apps render `url` in an `<Image>` and an admin puts it in a WhatsApp
 * message, and both only work because a Cloudinary upload yields an
 * absolute, unauthenticated URL. A local one yields an empty `url` on
 * purpose — the file exists, but not at an address a customer's phone
 * can open, and claiming otherwise is how a customer receives a 401.
 *
 * Cloudinary itself is stubbed. What is worth pinning here is the
 * choice between stores and the shape of the answer, not the SDK.
 */

const uploadStream = jest.fn();
const destroy = jest.fn();

jest.mock('cloudinary', () => ({
  v2: {
    config: jest.fn(),
    uploader: {
      upload_stream: (...args: unknown[]) => uploadStream(...args),
      destroy: (...args: unknown[]) => destroy(...args),
    },
  },
}));

const CLOUD_URL = 'cloudinary://123456789:s3cr3t-key@j1oli7ws';

const photo = (over: Partial<Express.Multer.File> = {}) =>
  ({
    buffer: Buffer.from('not really a jpeg'),
    originalname: 'IMG_0042.HEIC',
    mimetype: 'image/heic',
    size: 17,
    ...over,
  }) as Express.Multer.File;

/** A ConfigService over a plain object, keyed the way configuration.ts nests. */
const configFor = (values: Record<string, unknown>) =>
  ({ get: (key: string) => values[key] }) as ConfigService;

describe('parseCloudinaryUrl', () => {
  it('splits the credential into its three parts', () => {
    expect(parseCloudinaryUrl(CLOUD_URL)).toEqual({
      key: '123456789',
      secret: 's3cr3t-key',
      cloud: 'j1oli7ws',
    });
  });

  it.each([
    ['an empty string', ''],
    ['the wrong scheme', 'https://123:abc@j1oli7ws'],
    ['no cloud name', 'cloudinary://123:abc@'],
    ['no secret', 'cloudinary://123@j1oli7ws'],
  ])('refuses %s rather than half-configuring the SDK', (_name, url) => {
    expect(() => parseCloudinaryUrl(url)).toThrow(/CLOUDINARY_URL is malformed/);
  });
});

describe('InvoicesService, with Cloudinary configured', () => {
  let service: InvoicesService;

  beforeEach(() => {
    jest.clearAllMocks();
    uploadStream.mockImplementation((options: any, callback: any) => {
      /* The real SDK answers once the stream ends; so does this. */
      return {
        end: () =>
          callback(null, {
            public_id: options.folder + '/' + options.public_id,
            secure_url:
              'https://res.cloudinary.com/j1oli7ws/image/upload/v1/' +
              options.folder +
              '/' +
              options.public_id +
              '.jpg',
            bytes: 2048,
          }),
      };
    });

    service = new InvoicesService(
      configFor({
        'cloudinary.url': CLOUD_URL,
        'cloudinary.folder': 'taxmymotor/invoices',
        uploadDir: './uploads',
      }),
    );
  });

  it('returns an absolute URL, which is the whole point of the hosted store', async () => {
    const stored = await service.store('ORD-1019', photo());

    expect(stored.provider).toBe('cloudinary');
    expect(stored.url).toMatch(/^https:\/\/res\.cloudinary\.com\//);
  });

  /*
   * The hosted URL is unauthenticated by necessity, so the id is the
   * only thing between one customer's invoice and another's.
   * "ORD-1019.jpg" would be a guess away.
   */
  it('makes the public id unguessable rather than just the order number', async () => {
    const first = await service.store('ORD-1019', photo());
    const second = await service.store('ORD-1019', photo());

    expect(first.storageKey).not.toBe(second.storageKey);
    expect(first.storageKey).toMatch(/ORD-1019-[0-9a-f]{16}$/);
  });

  /* HEIC off an iPhone renders in neither a browser nor WhatsApp. */
  it('converts to JPEG on the way in, whatever the camera produced', async () => {
    const stored = await service.store('ORD-1019', photo());

    expect(uploadStream.mock.calls[0][0]).toMatchObject({ format: 'jpg' });
    expect(stored.mimeType).toBe('image/jpeg');
    expect(stored.fileName).toMatch(/\.jpg$/);
  });

  it('never lets the client name the file', async () => {
    const stored = await service.store('ORD/../../etc', photo({ originalname: '../../.env' }));

    /*
     * The folder prefix is Cloudinary's own and carries slashes, so the
     * assertion is on the part built from input: no traversal survives
     * it, and nothing the client sent appears in it at all.
     */
    const [, generated] = /^taxmymotor\/invoices\/(.+)$/.exec(stored.storageKey) ?? [];
    expect(generated).toMatch(/^ORDetc-[0-9a-f]{16}$/);
    expect(stored.fileName).not.toContain('..');
    expect(stored.fileName).not.toContain('env');
  });

  it('deletes from Cloudinary, not the disk', async () => {
    destroy.mockResolvedValue({ result: 'ok' });
    await service.remove('taxmymotor/invoices/ORD-1019-abc', 'cloudinary');

    expect(destroy).toHaveBeenCalledWith('taxmymotor/invoices/ORD-1019-abc', {
      resource_type: 'image',
    });
  });

  /* A failed delete is a stray file, not a failed request. */
  it('swallows a delete that fails', async () => {
    destroy.mockRejectedValue(new Error('gone'));
    await expect(
      service.remove('taxmymotor/invoices/ORD-1019-abc', 'cloudinary'),
    ).resolves.toBeUndefined();
  });

  it('turns an upload failure into a message a supplier can act on', async () => {
    uploadStream.mockImplementation((_options: any, callback: any) => ({
      end: () => callback(new Error('402 Payment Required'), null),
    }));

    await expect(service.store('ORD-1019', photo())).rejects.toThrow(
      'The invoice could not be saved. Please try again.',
    );
  });
});

describe('InvoicesService, with no Cloudinary credentials', () => {
  let dir: string;
  let service: InvoicesService;

  beforeEach(async () => {
    jest.clearAllMocks();
    dir = await fs.mkdtemp(join(tmpdir(), 'invoices-'));
    service = new InvoicesService(
      configFor({ 'cloudinary.url': '', uploadDir: dir }),
    );
  });

  afterEach(() => fs.rm(dir, { recursive: true, force: true }));

  it('writes the bytes to the upload directory', async () => {
    const stored = await service.store('ORD-1019', photo());

    await expect(fs.readFile(join(dir, stored.storageKey), 'utf8')).resolves.toBe(
      'not really a jpeg',
    );
    expect(uploadStream).not.toHaveBeenCalled();
  });

  /*
   * Empty, not the API path. A local invoice has no address a
   * customer's phone can open, and the apps key off exactly this to
   * decide whether the photo can be shown and sent.
   */
  it('reports no hosted copy, because there is none', async () => {
    const stored = await service.store('ORD-1019', photo());

    expect(stored.url).toBe('');
    expect(stored.provider).toBe('local');
  });

  it('keeps the original type rather than claiming a conversion it did not do', async () => {
    const stored = await service.store('ORD-1019', photo({ mimetype: 'image/png' }));

    expect(stored.mimeType).toBe('image/png');
    expect(stored.storageKey).toMatch(/\.png$/);
  });

  it('deletes the file', async () => {
    const stored = await service.store('ORD-1019', photo());
    await service.remove(stored.storageKey);

    await expect(fs.access(join(dir, stored.storageKey))).rejects.toThrow();
  });
});
