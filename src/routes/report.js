import { config } from '../config.js';
import { one } from '../db.js';
import { dailyReport, leadCounts, parseLeadRange, parseRange, reportAccess } from '../lib/report.js';

/**
 * Read-only, for the agency's own reports (n8n). On the administration's host
 * only, with a report key: the one for all clients (Upozornenia → Reporty) or a
 * client's own (its Nastavenia), which opens that client alone. The key goes in
 * `Authorization: Bearer …` or, like the nwr-lead-stats plugin's, in
 * `X-NWR-Leads-Key`. Without a valid key the API does not say that it exists.
 *
 *   GET /api/report/daily?from=YYYY-MM-DD&to=YYYY-MM-DD[&tenant=slug]
 *   GET /api/report/leads?since=YYYY-MM-DD&until=YYYY-MM-DD[&group=day|week|month][&forms=a,b][&tenant=slug]
 */
export default async function reportRoutes(app, opts = {}) {
  const access = opts.reportAccess || reportAccess;
  const daily = opts.dailyReport || dailyReport;
  const leads = opts.leadCounts || leadCounts;
  const tenantBySlug = opts.tenantBySlug || ((slug) => one(
    `SELECT id, slug, name, allowed_origins, plugin_version FROM tenants WHERE slug = $1 AND active`, [slug],
  ));
  const notFound = (reply) => reply.code(404).type('text/plain').send('not found');
  const slugOf = (q) => (/^[a-z0-9-]{1,64}$/.test(String(q?.tenant ?? '')) ? String(q.tenant) : null);

  /** Who is asking: null (and a 404 sent) unless on the right host with a valid key. */
  async function who(req) {
    const host = String(req.headers.host || '').toLowerCase().split(':')[0];
    if (host !== config.adminHost.toLowerCase()) return null;
    const given = String(req.headers['x-nwr-leads-key'] || req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    return access(given);
  }

  app.get('/api/report/daily', async (req, reply) => {
    const a = await who(req);
    if (!a) return notFound(reply);
    let range;
    try {
      range = parseRange(req.query);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
    reply.header('cache-control', 'no-store');
    // A client's own key opens that client, whatever the request names.
    return reply.send(await daily(range, { tenant: a.tenant ? a.tenant.slug : slugOf(req.query) }));
  });

  app.get('/api/report/leads', async (req, reply) => {
    const a = await who(req);
    if (!a) return notFound(reply);
    const tenant = a.tenant || (slugOf(req.query) ? await tenantBySlug(slugOf(req.query)) : null);
    if (!tenant) return reply.code(400).send({ error: 'tenant is required with the key of all clients' });
    let range;
    try {
      range = parseLeadRange(req.query);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
    reply.header('cache-control', 'no-store, private');
    return reply.send(await leads(tenant, range));
  });
}
