import { config } from '../config.js';
import { tenantByHost } from '../lib/tenants.js';
import { pluginRelease, releaseFile } from '../lib/plugin-release.js';

/**
 * Updates for the WordPress plugin, served on each client's collector host (the
 * plugin already talks to it) and on the dashboard host. The plugin installs a
 * release only after checking its Ed25519 signature against keys built into it.
 */
export default async function updateRoutes(app, { lookupTenant = tenantByHost, release = pluginRelease, file = releaseFile } = {}) {
  async function knownHost(req) {
    const host = String(req.headers.host || '').toLowerCase().split(':')[0];
    if (host && host === config.adminHost.toLowerCase()) return host;
    return (await lookupTenant(host)) ? host : null;
  }

  app.get('/wp/nowera-capi/info.json', async (req, reply) => {
    const host = await knownHost(req);
    const latest = release();
    if (!host || !latest) return reply.code(404).type('text/plain').send('not found');
    return reply.header('cache-control', 'no-store')
      .send({ ...latest, download_url: `https://${host}/wp/nowera-capi/${latest.file}` });
  });

  app.get('/wp/nowera-capi/:file', async (req, reply) => {
    const host = await knownHost(req);
    const zip = host ? file(req.params.file) : null;
    if (!zip) return reply.code(404).type('text/plain').send('not found');
    // A version's ZIP never changes; a new version gets a new name.
    return reply.header('cache-control', 'public, max-age=86400, immutable').type('application/zip').send(zip);
  });
}
