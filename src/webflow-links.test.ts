import assert from "node:assert/strict";
import test from "node:test";

import { webflowSiteDesignerUrl } from "./webflow-links.js";

test("builds the Webflow Designer link for a site short name", () => {
  assert.equal(webflowSiteDesignerUrl("datasaur"), "https://webflow.com/design/datasaur");
});

test("refuses a short name that could change the link target", () => {
  for (const value of ["", "  ", undefined, "data saur", "datasaur/../evil", "datasaur?next=x", "https://evil.example"]) {
    assert.equal(webflowSiteDesignerUrl(value), undefined);
  }
});
