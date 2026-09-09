import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused';

const { pool } = await import('../src/db.js');

test('the pool handles idle-client errors instead of crashing the process', () => {
  assert.ok(pool.listenerCount('error') > 0, 'pg.Pool without an error listener kills Node');

  // Exactly what Postgres sends when it restarts and drops idle clients.
  const pgRestart = Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
  assert.doesNotThrow(() => pool.emit('error', pgRestart, { release() {} }));
});
