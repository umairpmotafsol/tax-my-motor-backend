/**
 * Typed configuration, read once at boot. Nothing else in the app reads
 * process.env directly, so every setting has one name and one default.
 */
export interface AppConfig {
  env: string;
  port: number;
  apiPrefix: string;
  corsOrigins: string[];
  databaseUri: string;
  jwt: {
    accessSecret: string;
    refreshSecret: string;
    accessTtl: string;
    refreshTtl: string;
  };
  bcryptRounds: number;
  encryptionKey: string;
  /** How long a supplier has to upload the invoice. */
  responseTimeoutMs: number;
  serviceFee: number;
  v62Fee: number;
  uploadDir: string;
  maxUploadBytes: number;
  cloudinary: {
    /** cloudinary://<api_key>:<api_secret>@<cloud_name>. Blank = local disk. */
    url: string;
    folder: string;
  };
  seedOnBoot: boolean;
  seedDemoOrders: boolean;
  stripe: {
    secretKey: string;
    webhookSecret: string;
    publishableKey: string;
  };
  /**
   * Vehicle Data Global's R2 lookup. Pay-as-you-go and billed per
   * successful return, so every setting here exists to stop the app
   * spending money it did not mean to: `live` has to be switched on
   * deliberately, `cacheTtlMs` decides how long one paid answer is
   * reused, and `dailyCallLimit` is a hard ceiling per UTC day.
   */
  vehicleData: {
    apiKey: string;
    /** Host only, e.g. https://uk.api.vehicledataglobal.com — the /r2/lookup path is added by the client. */
    baseUrl: string;
    /** The package configured on the account. "Tax" returns VehicleTaxDetails. */
    packageName: string;
    /**
     * Optional second package carrying the identity fields the Tax
     * package does not return — model, colour, VIN, fuel type. Empty
     * means off, and a lookup then reports only what Tax can tell it
     * rather than inventing the rest. Each package is billed, so
     * switching this on doubles the cost of a plate.
     */
    detailsPackage: string;
    /** Off unless explicitly enabled — with it off nothing is ever charged. */
    live: boolean;
    /** How long a paid answer is served from the cache before another call is worth making. */
    cacheTtlMs: number;
    /** Hard ceiling on upstream calls per UTC day. */
    dailyCallLimit: number;
    /** The provider caps tax lookups at 1/second; calls are spaced by at least this. */
    minCallIntervalMs: number;
    requestTimeoutMs: number;
  };
}

const toList = (value?: string) =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

export default (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  apiPrefix: process.env.API_PREFIX ?? 'api',
  corsOrigins: toList(process.env.CORS_ORIGINS),
  databaseUri: process.env.DATABASE ?? '',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? '',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
    accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL ?? '30d',
  },
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS ?? '12', 10),
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  responseTimeoutMs: parseInt(process.env.RESPONSE_TIMEOUT_MS ?? '420000', 10),
  serviceFee: Number(process.env.SERVICE_FEE ?? 40),
  v62Fee: Number(process.env.V62_FEE ?? 40),
  uploadDir: process.env.UPLOAD_DIR ?? './uploads',
  maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES ?? '10485760', 10),
  /*
   * Where invoice photos are kept. With a CLOUDINARY_URL set they go to
   * Cloudinary and the customer's copy is a link the phone can open
   * without a token; without one they stay on the local disk, which is
   * fine for one developer and wrong for anything with two instances.
   */
  cloudinary: {
    url: process.env.CLOUDINARY_URL ?? '',
    folder: process.env.CLOUDINARY_FOLDER ?? 'taxmymotor/invoices',
  },
  seedOnBoot: process.env.SEED_ON_BOOT === 'true',
  seedDemoOrders: process.env.SEED_DEMO_ORDERS === 'true',
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? '',
  },
  vehicleData: {
    apiKey: process.env.VEHICLE_DATA_API_KEY ?? '',
    baseUrl: process.env.VEHICLE_DATA_BASE_URL ?? 'https://uk.api.vehicledataglobal.com',
    packageName: process.env.VEHICLE_DATA_PACKAGE ?? 'Tax',
    detailsPackage: process.env.VEHICLE_DATA_DETAILS_PACKAGE ?? '',
    live: process.env.VEHICLE_DATA_LIVE === 'true',
    cacheTtlMs: parseInt(process.env.VEHICLE_DATA_CACHE_TTL_MS ?? '86400000', 10),
    dailyCallLimit: parseInt(process.env.VEHICLE_DATA_DAILY_LIMIT ?? '200', 10),
    minCallIntervalMs: parseInt(process.env.VEHICLE_DATA_MIN_INTERVAL_MS ?? '1100', 10),
    requestTimeoutMs: parseInt(process.env.VEHICLE_DATA_TIMEOUT_MS ?? '10000', 10),
  },
});
