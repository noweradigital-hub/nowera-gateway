/** Consent tools the loader knows how to read. */
export const CONSENT_MODES = {
  none: 'Nekontrolovať (meria sa vždy)',
  cookiescript: 'CookieScript',
  complianz: 'Complianz',
  custom: 'Iný nástroj (cookie s prefixom)',
};

export function normalizeConsent(mode, prefix) {
  const m = Object.hasOwn(CONSENT_MODES, mode) ? mode : 'none';
  const p = String(prefix || 'cmplz_').replace(/[^a-zA-Z0-9_-]/g, '') || 'cmplz_';
  return { mode: m, prefix: p };
}
