import pg from 'pg';
import { config } from './config.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });

// An idle client that errors — Postgres restarting, or dropping the connection —
// emits 'error' on the pool. Without this listener Node treats it as an unhandled
// 'error' event and kills the process, so every database restart took the gateway
// down with it. Dropping the client is enough; the pool opens a fresh one.
pool.on('error', (err) => {
  console.error(JSON.stringify({
    level: 50,
    time: Date.now(),
    msg: 'idle postgres client error, connection dropped',
    err: { message: err.message, code: err.code },
  }));
});

export function query(text, params) {
  return pool.query(text, params);
}

export async function one(text, params) {
  const { rows } = await pool.query(text, params);
  return rows[0] || null;
}

export async function many(text, params) {
  const { rows } = await pool.query(text, params);
  return rows;
}
