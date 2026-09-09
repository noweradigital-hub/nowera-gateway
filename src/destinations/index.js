import * as meta from './meta.js';
import * as ga4 from './ga4.js';

export const drivers = { meta, ga4 };

export function driverFor(kind) {
  const driver = drivers[kind];
  if (!driver) throw new Error(`Unknown destination kind: ${kind}`);
  return driver;
}

/** Fields the admin UI renders for each destination kind. */
export const SCHEMAS = {
  meta: [
    { key: 'dataset_id', label: 'Dataset / Pixel ID', required: true },
    { key: 'access_token', label: 'Conversions API access token', required: true, secret: true },
    { key: 'test_event_code', label: 'Test event code (voliteľné)', required: false },
  ],
  ga4: [
    { key: 'measurement_id', label: 'Measurement ID (G-XXXXXXX)', required: true },
    { key: 'api_secret', label: 'API secret', required: true, secret: true },
  ],
};
