import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { loadImagePrompt, renderImagePrompt } from "./prompt.js";

test("renders the checked-in image prompt with the complete reviewed article", () => {
  const prompt = renderImagePrompt(
    "Title: {blog title}; Content: {blog content}",
    {
      title: "Open models shift adoption",
      content: "The article analyses AI industry adoption."
    }
  );

  assert.match(prompt, /Open models shift adoption/);
  assert.match(prompt, /analyses AI industry adoption/);
});

test("rejects an incomplete image prompt input", () => {
  assert.throws(
    () => renderImagePrompt("{blog title} {blog content}", { title: "", content: "body" }),
    /without a title/
  );
});

test("loads the checked-in prompt template rather than an untracked local prompt", async () => {
  const prompt = await loadImagePrompt({
    title: "A reviewed title",
    content: "A reviewed blog body."
  });

  assert.match(prompt, /^Generate an image following this design pattern/);
  assert.match(prompt, /"resolution": "1920x1080"/);
  assert.match(prompt, /A reviewed title/);
});

test("keeps the supplied prompt template unchanged", async () => {
  const prompt = await loadImagePrompt({ title: "Title", content: "Content" });
  const template = prompt.replace("Title: Title", "Title: {blog title}").replace("Content: Content", "Content: {blog content}");

  assert.equal(createHash("sha256").update(template).digest("hex"), "d3e1ae132c7dd5fbccc79284881dbfe9c9cc214ba2df498d9406e63279225919");
});
