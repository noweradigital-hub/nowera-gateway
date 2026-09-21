/** Consent tools the loader knows how to read. */
export const CONSENT_MODES = {
  none: 'Nekontrolovať (meria sa vždy)',
  cookiescript: 'CookieScript',
  complianz: 'Complianz',
  custom: 'Iný nástroj (cookie s prefixom)',
};

/** Same-site path of the cookie keeper, or null. Never a URL: it must stay on the page's own origin. */
export function normalizeKeepPath(value) {
  const path = String(value ?? '').trim();
  return /^\/[A-Za-z0-9._~\/-]{1,200}$/.test(path) && !path.includes('//') ? path : null;
}

export function normalizeConsent(mode, prefix) {
  const m = Object.hasOwn(CONSENT_MODES, mode) ? mode : 'none';
  const p = String(prefix || 'cmplz_').replace(/[^a-zA-Z0-9_-]/g, '') || 'cmplz_';
  return { mode: m, prefix: p };
}
