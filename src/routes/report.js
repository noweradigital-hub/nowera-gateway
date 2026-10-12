import { config } from '../config.js';
import { dailyReport, parseRange, reportKeyValid } from '../lib/report.js';

/**
 * GET /api/report/daily?from=YYYY-MM-DD&to=YYYY-MM-DD[&tenant=slug]
 *
 * Read-only, for the agency's own reports (n8n). On the administration's host
 * only, with the report key from the administration in the Authorization
 * header (Bearer). Without a valid key it does not say that it exists.
 */
export default async function reportRoutes(app) {
  app.get('/api/report/daily', async (req, reply) => {
    const host = String(req.headers.host || '').toLowerCase().split(':')[0];
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    if (host !== config.adminHost.toLowerCase() || !(await reportKeyValid(given))) {
      return reply.code(404).type('text/plain').send('not found');
    }
    let range;
    try {
      range = parseRange(req.query);
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
    const tenant = /^[a-z0-9-]{1,64}$/.test(String(req.query?.tenant ?? '')) ? String(req.query.tenant) : null;
    reply.header('cache-control', 'no-store');
    return reply.send(await dailyReport(range, { tenant }));
  });
}
