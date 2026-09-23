import * as Joi from 'joi';

/**
 * Checked at boot, so a missing secret or a malformed connection string
 * stops the process here rather than surfacing as a confusing 500 on
 * the first request that happens to need it.
 */
export const validationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'staging', 'production').default('development'),
  PORT: Joi.number().port().default(4000),
  API_PREFIX: Joi.string().default('api'),
  CORS_ORIGINS: Joi.string().allow('').default(''),

  DATABASE: Joi.string().uri({ scheme: ['mongodb', 'mongodb+srv'] }).required(),

  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_TTL: Joi.string().default('15m'),
  JWT_REFRESH_TTL: Joi.string().default('30d'),
  BCRYPT_ROUNDS: Joi.number().min(10).max(15).default(12),

  // 32 bytes, hex encoded. Optional in development, required in production.
  ENCRYPTION_KEY: Joi.string()
    .length(64)
    .hex()
    .when('NODE_ENV', { is: 'production', then: Joi.required(), otherwise: Joi.optional().allow('') }),

  RESPONSE_TIMEOUT_MS: Joi.number().min(1000).default(420000),
  SERVICE_FEE: Joi.number().min(0).default(40),
  V62_FEE: Joi.number().min(0).default(40),

  UPLOAD_DIR: Joi.string().default('./uploads'),
  MAX_UPLOAD_BYTES: Joi.number().min(1024).default(10485760),

  // cloudinary://<api_key>:<api_secret>@<cloud_name>, from the console's
  // dashboard. Blank keeps invoices on the local disk.
  CLOUDINARY_URL: Joi.string()
    .pattern(/^cloudinary:\/\/[^:]+:[^@]+@[\w-]+$/)
    .allow('')
    .default(''),
  CLOUDINARY_FOLDER: Joi.string().default('taxmymotor/invoices'),

  SEED_ON_BOOT: Joi.boolean().truthy('true').falsy('false').default(false),
  SEED_DEMO_ORDERS: Joi.boolean().truthy('true').falsy('false').default(false),

  // Blank until a real key is dropped in — the routes exist either way,
  // and answer 503 ("not configured") rather than guess at a fake price
  // or a fake tax record while the key is missing.
  STRIPE_SECRET_KEY: Joi.string().allow('').default(''),
  STRIPE_WEBHOOK_SECRET: Joi.string().allow('').default(''),
  STRIPE_PUBLISHABLE_KEY: Joi.string().allow('').default(''),

  VEHICLE_DATA_API_KEY: Joi.string().allow('').default(''),
  VEHICLE_DATA_BASE_URL: Joi.string().allow('').default('https://uk.api.vehicledataglobal.com'),
  VEHICLE_DATA_PACKAGE: Joi.string().default('Tax'),
  /** Empty means the identity fields stay blank rather than being guessed. */
  VEHICLE_DATA_DETAILS_PACKAGE: Joi.string().allow('').default(''),

  // Vehicle Data Global bills per successful lookup, so live calls are
  // off until someone turns them on, and cannot be turned on without a
  // key. Everything below is a spend guard, not a tuning knob.
  VEHICLE_DATA_LIVE: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false)
    .when('VEHICLE_DATA_API_KEY', {
      is: Joi.string().min(1).required(),
      otherwise: Joi.valid(false).messages({
        'any.only': 'VEHICLE_DATA_LIVE cannot be true without VEHICLE_DATA_API_KEY.',
      }),
    }),
  VEHICLE_DATA_CACHE_TTL_MS: Joi.number().min(0).default(86400000),
  VEHICLE_DATA_DAILY_LIMIT: Joi.number().min(0).default(200),
  VEHICLE_DATA_MIN_INTERVAL_MS: Joi.number().min(0).default(1100),
  VEHICLE_DATA_TIMEOUT_MS: Joi.number().min(1000).default(10000),
});
