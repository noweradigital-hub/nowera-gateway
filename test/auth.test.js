import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://unused';

const { hashPassword, verifyPassword, validateNewPassword, MIN_PASSWORD_LENGTH } =
  await import('../src/lib/auth.js');

test('a hashed password verifies, a wrong one does not', async () => {
  const stored = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', stored), true);
  assert.equal(await verifyPassword('Correct horse battery staple', stored), false);
  assert.equal(await verifyPassword('', stored), false);
});

test('each hash gets its own salt', async () => {
  const [a, b] = await Promise.all([hashPassword('same'), hashPassword('same')]);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same', a), true);
  assert.equal(await verifyPassword('same', b), true);
});

test('a malformed stored hash is rejected rather than throwing', async () => {
  for (const stored of ['', 'garbage', 'scrypt$onlysalt', 'md5$abc$def']) {
    assert.equal(await verifyPassword('x', stored), false, `stored: ${stored}`);
  }
});

test('new passwords must be long enough and typed twice', () => {
  const long = 'x'.repeat(MIN_PASSWORD_LENGTH);
  assert.equal(validateNewPassword(long, long), null);

  assert.match(validateNewPassword('', ''), /Zadajte nové heslo/);
  assert.match(validateNewPassword('short', 'short'), new RegExp(`${MIN_PASSWORD_LENGTH} znakov`));
  assert.match(validateNewPassword(long, `${long}!`), /nezhodujú/);
});
