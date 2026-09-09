import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { one, query } from '../db.js';

const scrypt = promisify(_scrypt);
const KEYLEN = 64;
const SESSION_DAYS = 14;

export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, salt, hex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;
  const derived = await scrypt(password, salt, KEYLEN);
  const expected = Buffer.from(hex, 'hex');
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(derived, expected);
}

export async function createSession(userId) {
  const token = randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await query(
    'INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)',
    [token, userId, expires],
  );
  return { token, expires };
}

export async function getSessionUser(token) {
  if (!token) return null;
  return one(
    `SELECT u.id, u.email
       FROM sessions s
       JOIN admin_users u ON u.id = s.user_id
      WHERE s.token = $1 AND s.expires_at > now()`,
    [token],
  );
}

export const destroySession = (token) =>
  query('DELETE FROM sessions WHERE token = $1', [token]);

export const purgeExpiredSessions = () =>
  query('DELETE FROM sessions WHERE expires_at < now()');

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Reject a new password before it is hashed. Returns null when acceptable,
 * otherwise a message meant for the person typing it.
 */
export function validateNewPassword(password, confirmation) {
  if (!password) return 'Zadajte nové heslo.';
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Nové heslo musí mať aspoň ${MIN_PASSWORD_LENGTH} znakov.`;
  }
  if (password !== confirmation) return 'Nové heslá sa nezhodujú.';
  return null;
}

/**
 * Change a password and drop every other session for that user, so a stolen
 * cookie stops working the moment the password is rotated. `keepToken` is the
 * session doing the change, which stays signed in.
 */
export async function changePassword(userId, newPassword, keepToken) {
  const hash = await hashPassword(newPassword);
  await query('UPDATE admin_users SET password_hash = $1 WHERE id = $2', [hash, userId]);
  const { rowCount } = await query(
    'DELETE FROM sessions WHERE user_id = $1 AND token <> $2',
    [userId, keepToken || ''],
  );
  return rowCount;
}
