import { readFileSync } from 'node:fs';
import { config } from '../config.js';

/**
 * The administration's icon: the browser tab, the sidebar and a phone's home
 * screen. Read once at start; served on the administration's host only, the
 * collector hosts have nothing to show.
 */
const dir = new URL('../public/', import.meta.url);
const FILES = {
  '/favicon.ico': 'icon-32.png',
  '/icon-32.png': 'icon-32.png',
  '/icon-64.png': 'icon-64.png',
  '/apple-touch-icon.png': 'icon-180.png',
};

export default async function assetRoutes(app) {
  const cache = Object.fromEntries(Object.entries(FILES).map(([path, file]) => [path, readFileSync(new URL(file, dir))]));
  for (const path of Object.keys(FILES)) {
    app.get(path, async (req, reply) => {
      const host = String(req.headers.host || '').toLowerCase().split(':')[0];
      if (host !== config.adminHost.toLowerCase()) return reply.code(404).type('text/plain').send('not found');
      return reply.type('image/png').header('cache-control', 'public, max-age=604800').send(cache[path]);
    });
  }
}
