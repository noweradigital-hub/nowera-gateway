/**
 * Crawlers, previewers and uptime monitors. Their page views are not people:
 * forwarding them to an ad platform inflates the numbers, pollutes audiences
 * and wastes the delivery model's budget on machines.
 */
const BOT = /bot\b|bots\b|crawl|spider|slurp|scrape|facebookexternalhit|facebookcatalog|meta-externalagent|headlesschrome|phantomjs|puppeteer|playwright|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitoring|preview|curl\/|wget|python-requests|go-http-client|java\/|okhttp|axios\/|node-fetch|semrush|ahrefs|mj12|dotbot|dataprovider|petal|seznam|yandex|baidu|sogou|duckduck|applebot|gptbot|claudebot|ccbot|perplexity|amazonbot|bytespider|feedfetcher|google-inspectiontool|chrome-lighthouse/i;

export function isBot(userAgent) {
  return typeof userAgent === 'string' && BOT.test(userAgent);
}
