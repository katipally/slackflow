import assert from "node:assert/strict";
import test from "node:test";

import { truncationNote, webflowCollectionsFromData, webflowSitesFromData } from "./webflow-selection.js";

const sitesResponse = {
  label: "list",
  result: {
    sites: [
      { id: "site-1", displayName: "Datasaur Main Website", shortName: "datasaur" },
      { id: "site-2", displayName: "Copy of Datasaur", shortName: "datasaur-copy" }
    ],
    pagination: { total: 2, offset: 0, returned: 2 }
  }
};

test("reads sites with their short names from the real MCP response shape", () => {
  const sites = webflowSitesFromData(sitesResponse);

  assert.equal(sites.total, 2);
  assert.deepEqual(sites.choices[0], { id: "site-1", label: "Datasaur Main Website", shortName: "datasaur" });
});

test("keeps the reported total when Webflow paginates beyond the returned page", () => {
  const sites = webflowSitesFromData({ result: { sites: [{ id: "site-1", displayName: "One" }], pagination: { total: 140 } } });

  assert.equal(sites.total, 140);
  assert.equal(sites.choices.length, 1);
  assert.match(truncationNote(1, 140, "sites"), /first 1 of 140 sites/);
});

test("does not claim truncation when everything fits", () => {
  assert.equal(truncationNote(2, 2, "sites"), "");
});

test("never mistakes a nested non-site object for a site", () => {
  const sites = webflowSitesFromData({ result: { sites: [{ id: "site-1", displayName: "One", workspace: { id: "workspace-9", name: "Team" } }] } });

  assert.deepEqual(sites.choices.map((site) => site.id), ["site-1"]);
});

test("reads collections and ignores the site wrapper", () => {
  const collections = webflowCollectionsFromData({
    result: { collections: [{ id: "collection-1", displayName: "Forge Blog Posts", slug: "post" }] }
  });

  assert.deepEqual(collections.choices, [{ id: "collection-1", label: "Forge Blog Posts" }]);
  assert.equal(collections.total, 1);
});

test("falls back to a crawl when the response has no named array", () => {
  const collections = webflowCollectionsFromData({ data: { items: [{ id: "collection-7", name: "Blog" }] } });

  assert.deepEqual(collections.choices, [{ id: "collection-7", label: "Blog" }]);
});

test("returns nothing selectable for an empty response", () => {
  assert.deepEqual(webflowSitesFromData({}).choices, []);
  assert.deepEqual(webflowCollectionsFromData(undefined).choices, []);
});

test("caps a huge site list at the Slack menu limit while reporting the real total", () => {
  const sites = webflowSitesFromData({
    sites: Array.from({ length: 150 }, (_item, index) => ({ id: `site-${index}`, displayName: `Site ${index}` }))
  });

  assert.equal(sites.choices.length, 100);
  assert.equal(sites.total, 150);
});
