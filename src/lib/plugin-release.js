import { existsSync, readFileSync } from 'node:fs';

/**
 * The released WordPress plugin, as scripts/release-plugin.mjs left it in
 * wp-plugin/releases: a signed ZIP per version and latest.json pointing at the
 * newest. Baked into the image, so each deploy carries the current release.
 */

export const RELEASES = new URL('../../wp-plugin/releases/', import.meta.url);

let cached;

/** { version, file, sha256, signature, … } of the newest release, or null. */
export function pluginRelease() {
  if (cached === undefined) {
    try {
      cached = JSON.parse(readFileSync(new URL('latest.json', RELEASES), 'utf8'));
    } catch {
      cached = null;
    }
  }
  return cached;
}

export function releaseFile(name) {
  if (!/^nowera-capi-[0-9][0-9A-Za-z.-]*\.zip$/.test(name)) return null;
  const url = new URL(name, RELEASES);
  return existsSync(url) ? readFileSync(url) : null;
}

/** Whether version a is newer than b (numeric parts, "1.10.0" > "1.9.2"). */
export function newer(a, b) {
  const pa = String(a || '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  const pb = String(b || '').split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}
