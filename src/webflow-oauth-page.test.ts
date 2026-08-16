import assert from "node:assert/strict";
import test from "node:test";

import { renderWebflowOAuthPage } from "./webflow-oauth-page.js";

test("renders a safe, actionable Webflow OAuth confirmation page", () => {
  const page = renderWebflowOAuthPage({
    detail: "The connection was saved.",
    heading: "Webflow is connected",
    success: true
  });

  assert.match(page, /Webflow is connected/);
  assert.match(page, /confirmation has been posted in the Slack thread/);
  assert.match(page, /Close this tab/);
  assert.doesNotMatch(page, /<script/);
});

test("escapes untrusted OAuth page content", () => {
  const page = renderWebflowOAuthPage({ detail: "<img src=x>", heading: "<unsafe>", success: false });
  assert.match(page, /&lt;unsafe&gt;/);
  assert.match(page, /&lt;img src=x&gt;/);
  assert.doesNotMatch(page, /<img src=x>/);
});
