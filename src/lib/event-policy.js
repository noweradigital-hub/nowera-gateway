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

/**
 * Our event names as OpenAI Ads knows them, with the shape of their data
 * (https://developers.openai.com/ads/supported-events). Shared by the gateway's
 * OpenAI destination and px.js, which reports the same events to the OpenAI
 * pixel under the same ids. Anything not listed is not sent to OpenAI: GA4-only
 * funnel steps, refunds, and events with no OpenAI counterpart.
 */
export const OPENAI_EVENTS = {
  PageView: ['page_viewed', 'contents'],
  ViewContent: ['contents_viewed', 'contents'],
  AddToCart: ['items_added', 'contents'],
  InitiateCheckout: ['checkout_started', 'contents'],
  Purchase: ['order_created', 'contents'],
  Lead: ['lead_created', 'customer_action'],
  CompleteRegistration: ['registration_completed', 'customer_action'],
  Schedule: ['appointment_scheduled', 'customer_action'],
  Subscribe: ['subscription_created', 'plan_enrollment'],
  StartTrial: ['trial_started', 'plan_enrollment'],
};
