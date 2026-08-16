---
title: Slackflow
emoji: "💬"
colorFrom: blue
colorTo: purple
sdk: docker
app_port: 7860
---

# Slackflow

Slackflow is a Slack agent that will turn the full context of an invoked Slack thread into a reviewed Webflow CMS draft.

## Current milestone

The local bot runs in Slack Socket Mode and responds to an in-thread `@Slackflow draft` mention by fetching the complete thread up to that mention and producing a no-write, structured draft proposal. It uses a provider-neutral model interface; the initial adapter sends one direct native-`fetch` request to the OpenAI Responses API with `gpt-5.6-luna`. It has no OpenAI SDK, agent framework, tools, or Webflow connection.

Slackflow uses a **strict transfer** design. The model cannot supply `title`, `body_markdown`, dates, URLs, or image briefs directly. It may only select exact character-for-character text spans from captured Slack messages; Slackflow verifies each selected span locally and derives the displayed fields itself. It rejects fabricated text, reordered body spans, unknown source messages, and the retired `compose` mode. If exact source title/body text is unavailable, it returns `needs_input` instead of writing a draft.

The only editorial classification is a closed, auditable Webflow Tag taxonomy: `NLP Labeling`, `Labeling`, `AI Industry`, or `Datasaur`. It returns `needs_input` rather than inventing a required tag when the article cannot be classified confidently.

The repository also contains a separate, provider-neutral image-generation contract and the user's verbatim prompt template at `prompts/image-generation.txt`. A ready `@Slackflow draft` run uploads one Slack reply with the strict-transfer proposal, the full transferred draft as a `.md` file, and one Blog Image. It makes no Webflow request or CMS change. This one command incurs one image-generation request only when the proposal is `ready`; `needs_input` and `conflict` proposals do not generate an image. The prompt remains unchanged at 1920×1080. GPT Image 2 generates its documented 1536×1024 landscape source, then Slackflow places it without cropping onto a pure-black **1920×1080** canvas, which is the delivered Slack/Webflow asset.

Every draft command is claimed in a small durable SQLite ledger before any external call. A delayed/repeated Slack delivery or process restart cannot create a second draft or image for the same command. The state file holds only IDs, timestamps, and status; configure `SLACKFLOW_STATE_PATH` on persistent storage when hosting.

For host-specific deployment constraints—especially why Hugging Face's default disk cannot retain this SQLite file—read [DEPLOYMENT.md](DEPLOYMENT.md).

The transcript collector includes Slack messages from every participant, paginates long threads, removes Slackflow's own replies by both bot user ID and bot ID, removes the compact invocation command, excludes messages posted after invocation, and deduplicates paginated results by timestamp. It logs fetched, removed, and final source counts. Version 1 captures message text only; Slack files, images, previews, and external links are deliberately out of scope until their data policy is implemented.

## Local setup

1. Copy `.env.example` to `.env`.
2. Add the three Slack development credentials to `.env`.
3. Add the following model settings to `.env` (do not remove your existing `OPENAI_API_KEY`):

   ```text
   LLM_PROVIDER=openai
   LLM_MODEL=gpt-5.6-luna
   LLM_REASONING_EFFORT=medium
   ```

   Slackflow's application logic talks to a provider-neutral contract. `openai` is the only implemented adapter in this milestone; another provider is added as a separate, tested native HTTP adapter without changing Slack, validation, or Webflow code.
   The future image workflow has a separate adapter and configuration:

   ```text
   IMAGE_PROVIDER=openai
   IMAGE_MODEL=gpt-image-2
   IMAGE_BLOG_SIZE=1536x1024
   IMAGE_QUALITY=medium
   IMAGE_OUTPUT_FORMAT=jpeg
   ```
4. Install packages with `npm install`.
5. Run `npm run check` and `npm test`.
6. Start the bot with `npm run dev`.
7. In `#slackflow-sandbox`, create a thread with two or more replies, then mention `@Slackflow draft` in that thread.
8. To enable the combined review upload, add the `files:write` bot token scope in the Slack app configuration, reinstall the app, and restart the local bot. Then use `@Slackflow draft` once in a test thread. A ready result posts the proposal and attaches the full `.md` draft plus one Blog Image.

Never commit `.env`.
