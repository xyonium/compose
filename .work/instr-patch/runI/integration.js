// src/integration.ts
var TAGGED_PATH = /^\/v2\/(scrape|batch\/scrape|crawl|map|search|extract|agent|parse|feedback|scrape\/[^/]+\/interact|search\/[^/]+\/feedback)$/;
function integrationFrom(value) {
  const tag = (value ?? "").trim();
  return tag === "" ? void 0 : tag;
}
function pathOf(url) {
  const path = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "").split(/[?#]/)[0];
  return path.replace(/\/+$/, "");
}
function withIntegration(url, body, integration) {
  if (!integration || body.integration != null) return body;
  if (!TAGGED_PATH.test(pathOf(url))) return body;
  return { ...body, integration };
}
export {
  integrationFrom,
  withIntegration
};
