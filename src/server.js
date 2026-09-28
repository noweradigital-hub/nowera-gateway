import http from 'node:http';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { assertConfig, config } from './config.js';
import { pool } from './db.js';
import { startWorker } from './lib/queue.js';
import { startStatsWriter } from './lib/stats-writer.js';
import { startAlerts } from './lib/alerts.js';
import { sealStoredSecrets } from './lib/seal-stored.js';
import { startBackups } from './lib/backup.js';
import { polls, traefikConfig } from './lib/routing.js';
import collectRoutes from './routes/collect.js';
import adminRoutes from './routes/admin.js';
import updateRoutes from './routes/updates.js';

assertConfig();

const app = Fastify({
  logger: { level: config.isProd ? 'info' : 'debug' },
  // Traefik terminates TLS; trust its forwarding headers for the real client IP.
  trustProxy: true,
  bodyLimit: 256 * 1024,
  // /admin/ and /admin are the same page.
  routerOptions: { ignoreTrailingSlash: true },
});

await app.register(cookie, { secret: config.sessionSecret });
await app.register(formbody);
await app.register(collectRoutes);
await app.register(adminRoutes);
await app.register(updateRoutes);

app.setNotFoundHandler((req, reply) => reply.code(404).type('text/plain').send('not found'));

// Before the worker reads any token: rows from before sealing get sealed now.
await sealStoredSecrets(app.log).catch((err) => app.log.error({ err }, 'sealing stored secrets failed'));

const stopWorker = startWorker(app.log);
const stopStats = startStatsWriter(app.log);
const stopAlerts = startAlerts(app.log);
const stopBackups = startBackups(app.log);
let internal = null;

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  stopWorker();
  stopAlerts();
  stopBackups();
  internal?.close();
  await stopStats();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });

// For other containers only (the port is not routed by Traefik): the collector
// hosts, in the format of Traefik's HTTP provider.
internal = http.createServer(async (req, res) => {
  if (req.method !== 'GET' || req.url !== '/traefik/config') {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = JSON.stringify(await traefikConfig());
    polls.last = new Date();
    res.writeHead(200, { 'content-type': 'application/json' }).end(body);
  } catch (err) {
    app.log.error({ err }, 'traefik config failed');
    res.writeHead(500).end();
  }
});
internal.listen(config.internalPort, '0.0.0.0');
