/**
 * Which destination an event is for, shared by the gateway's routing and px.js
 * (whose Meta pixel would otherwise report every event it sees).
 *
 * Funnel steps that GA4 reports on but Meta has no standard event for would only
 * be custom events cluttering the dataset, so they go to GA4 alone. Meta has no
 * refund event either.
 */
export const ANALYTICS_ONLY = ['ViewCart', 'RemoveFromCart', 'AddShippingInfo', 'SelectItem', 'Login'];

export const NOT_FOR_META = new Set(['Refund', ...ANALYTICS_ONLY]);
