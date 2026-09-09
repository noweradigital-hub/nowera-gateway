const env = process.env;

export const config = {
  port: Number(env.PORT || 8080),
  isProd: env.NODE_ENV === 'production',
  sessionSecret: env.SESSION_SECRET || '',
  ingestSecret: env.INGEST_SECRET || '',
  databaseUrl: env.DATABASE_URL || '',
  adminHost: env.ADMIN_HOST || '',
  batchSize: Number(env.BATCH_SIZE || 25),
  workerIntervalMs: Number(env.WORKER_INTERVAL_MS || 2000),
  retentionDays: Number(env.RETENTION_DAYS || 30),
  // Meta bumps this roughly twice a year; changing it here changes it for every tenant.
  metaApiVersion: env.META_API_VERSION || 'v21.0',
};

/**
 * Validated at startup rather than at import time, so unit tests can import a
 * single destination driver without a full environment.
 */
export function assertConfig() {
  const missing = ['sessionSecret', 'ingestSecret', 'databaseUrl', 'adminHost']
    .filter((key) => !config[key]);
  if (missing.length) {
    const names = { sessionSecret: 'SESSION_SECRET', ingestSecret: 'INGEST_SECRET', databaseUrl: 'DATABASE_URL', adminHost: 'ADMIN_HOST' };
    throw new Error(`Missing required env vars: ${missing.map((k) => names[k]).join(', ')}`);
  }
  if (config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
}
