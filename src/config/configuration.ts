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
  /** The flat price of a "Reg > VIN" lookup. No service fee is added to it. */
  vinFee: number;
  /** The flat price of a pair of number plates, delivered. No service fee is added to it. */
  platesFee: number;
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
   * Push notifications, through Firebase Cloud Messaging. The whole
   * feature is switched on by one file being present: a missing or
   * unreadable credentials file leaves push off and the app otherwise
   * untouched, which is what a developer without the key wants.
   */
  push: {
    /** A Firebase service-account JSON, relative to the project root. */
    credentialsFile: string;
  };
  /**
   * SMTP, for the invoice a customer is emailed when the supplier
   * uploads it. Optional in the same way push is: with no host or
   * credentials nothing is sent, and the order's timeline says so
   * rather than claiming an email that never left.
   */
  mail: {
    host: string;
    port: number;
    username: string;
    password: string;
    /** `TaxMyMotor <billing@example.co.uk>` — what the customer sees it came from. */
    from: string;
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
     * Optional second package — "VehicleDetails" — carrying what DVLA's
     * rate tables need (vehicle type, registration date, engine size,
     * weight, seats) and the identity fields besides. Called only for a
     * plate the Tax package could not price, so a priced plate is still
     * one billed call. Empty means off: such a vehicle stays unpriced.
     */
    detailsPackage: string;
    /**
     * Optional package for a car's list price when new — "ValuationDetails".
     * Called only when the provider gives no tax rate and the price could
     * decide the expensive car supplement; empty means off, and such a car
     * is quoted the standard rate.
     */
    valuationPackage: string;
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
  /**
   * "Find address" on the V62 screen. Optional in the same way push and
   * mail are: with no URL the search answers that it is unavailable and
   * the customer types their address instead.
   */
  addressLookup: {
    /** Answers `GET <url>?postcode=` — the TaxMyMotor website's own /api/address-lookup. */
    url: string;
    timeoutMs: number;
  };
}

const toList = (value?: string) =>
  (value ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

/**
 * The sender. MAIL_FROM when it is set; otherwise the SMTP account
 * itself, when that is an address — which it is on most hosts, and
 * saves a setting that would only repeat it.
 */
const mailFrom = (explicit?: string, username?: string): string => {
  if (explicit?.trim()) {
    return explicit.trim();
  }
  return username?.includes('@') ? 'TaxMyMotor <' + username.trim() + '>' : '';
};

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
  vinFee: Number(process.env.VIN_FEE ?? 0.99),
  platesFee: Number(process.env.PLATES_FEE ?? 20),
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
  push: {
    credentialsFile: process.env.FIREBASE_CREDENTIALS ?? './firebaseintegeration.json',
  },
  mail: {
    host: process.env.SMTP_HOST ?? '',
    port: parseInt(process.env.SMTP_PORT ?? '465', 10),
    username: process.env.SMTP_USERNAME ?? '',
    password: process.env.SMTP_PASSWORD ?? '',
    from: mailFrom(process.env.MAIL_FROM, process.env.SMTP_USERNAME),
  },
  vehicleData: {
    apiKey: process.env.VEHICLE_DATA_API_KEY ?? '',
    baseUrl: process.env.VEHICLE_DATA_BASE_URL ?? 'https://uk.api.vehicledataglobal.com',
    packageName: process.env.VEHICLE_DATA_PACKAGE ?? 'Tax',
    detailsPackage: process.env.VEHICLE_DATA_DETAILS_PACKAGE ?? '',
    valuationPackage: process.env.VEHICLE_DATA_VALUATION_PACKAGE ?? '',
    live: process.env.VEHICLE_DATA_LIVE === 'true',
    cacheTtlMs: parseInt(process.env.VEHICLE_DATA_CACHE_TTL_MS ?? '86400000', 10),
    dailyCallLimit: parseInt(process.env.VEHICLE_DATA_DAILY_LIMIT ?? '200', 10),
    minCallIntervalMs: parseInt(process.env.VEHICLE_DATA_MIN_INTERVAL_MS ?? '1100', 10),
    requestTimeoutMs: parseInt(process.env.VEHICLE_DATA_TIMEOUT_MS ?? '10000', 10),
  },
  addressLookup: {
    url: process.env.ADDRESS_LOOKUP_URL ?? '',
    timeoutMs: parseInt(process.env.ADDRESS_LOOKUP_TIMEOUT_MS ?? '8000', 10),
  },
});
