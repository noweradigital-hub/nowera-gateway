import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import { assertConfig, config } from './config.js';
import { pool } from './db.js';
import { startWorker } from './lib/queue.js';
import collectRoutes from './routes/collect.js';
import adminRoutes from './routes/admin.js';

assertConfig();

const app = Fastify({
  logger: { level: config.isProd ? 'info' : 'debug' },
  // Traefik terminates TLS; trust its forwarding headers for the real client IP.
  trustProxy: true,
  bodyLimit: 256 * 1024,
});

await app.register(cookie, { secret: config.sessionSecret });
await app.register(formbody);
await app.register(collectRoutes);
await app.register(adminRoutes);

app.setNotFoundHandler((req, reply) => reply.code(404).type('text/plain').send('not found'));

const stopWorker = startWorker(app.log);

async function shutdown(signal) {
  app.log.info({ signal }, 'shutting down');
  stopWorker();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

await app.listen({ port: config.port, host: '0.0.0.0' });
