/** A Meta test event code applies for this long after it is saved, then lapses. */
export const TEST_MODE_MINUTES = 60;

/** Whether a destination is in test mode right now. */
export function testModeActive(settings, now = Date.now()) {
  return Boolean(settings?.test_event_code) && Date.parse(settings?.test_until || '') > now;
}
