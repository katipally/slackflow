# Slackflow Setup Progress

This is the running record of completed setup work. It intentionally contains no passwords, tokens, signing secrets, or API keys.

## Completed

### Step 1 — Slack development app

**Status:** Complete  
**Environment:** Slack test workspace

The following setup has been completed for the `Slackflow Dev` Slack app:

- Created the `Slackflow Dev` Slack app in a test workspace.
- Enabled Socket Mode.
- Created an app-level token with the `connections:write` scope.
- Added bot token scopes:
  - `app_mentions:read`
  - `chat:write`
  - `channels:history`
  - `groups:history` (required after the sandbox channel was made private)
- Enabled Event Subscriptions and subscribed to `app_mention`.
- Installed the app to the test workspace.
- Securely saved the app-level token, bot token, and Slack signing secret outside this repository.
- Created the `#slackflow-sandbox` public test channel.
- Invited `Slackflow Dev` to `#slackflow-sandbox`.

## Next

### Step 2 — Local development credentials

**Status:** Complete

- Created `.env` from `.env.example` locally.
- Added the Slackflow Dev signing secret, bot token, and app-level Socket Mode token.
- Did not add OpenAI or Webflow credentials yet.

## Next

### Step 3 — Run the local Slackflow bot and prove private-thread capture

**Status:** Complete

- Installed the Slackflow Node dependencies.
- Passed the TypeScript type check and thread-collection test.
- Started Slackflow Dev locally in Socket Mode.
- Confirmed the app received an `@Slackflow` mention in the private `#slack-to-webflow` test channel.
- Initially received Slack's `missing_scope` error because the channel was private.
- Added `groups:history`, reinstalled the app, and restarted the local bot.
- Confirmed Slackflow captured the full invoked thread successfully and posted the expected message-count confirmation.

## Next

### Step 4 — OpenAI development project and key

**Status:** Complete

- Created a dedicated OpenAI development project/API key for Slackflow.
- Stored the key locally in `.env` only.
- Did not share the key or commit it to the repository.

## Next

### Step 5 — Test the provider-neutral model harness

**Status:** Complete

The following implementation work is complete and verified offline:

- Introduced a provider-neutral `DraftModelProvider` contract that isolates provider HTTP details from Slackflow's Slack, validation, and future Webflow code.
- Added the initial direct native-`fetch` OpenAI Responses API adapter. It uses no OpenAI SDK or agent framework.
- Set the configured development default to `gpt-5.6-luna` with `medium` reasoning effort.
- Added strict JSON-schema response parsing and a local strict-transfer boundary: the model supplies only exact source selections, while Slackflow derives title, body, and transferable metadata itself.
- Updated thread capture to paginate Slack replies, exclude posts made after the invocation, remove Slackflow's own messages and the invocation command itself, and deduplicate repeated page results.
- Ran `npm run check` successfully.
- Ran `npm test` successfully: 24 tests passed, including adversarial checks that reject fabricated source text, compose mode, changed body ordering, invented tag values, duplicate Slack deliveries, and a persisted idempotency ledger. The test suite also proves that an untrusted free-form `fields` object is ignored in favor of verified source selections.
- Completed a successful live Slack test. Slackflow invoked the configured model, received a provider response ID, made no Webflow change, preserved explicit blanks, and correctly left an unprovided source URL blank.
- Updated the preview to show the exact transfer-source timestamp for each displayed field. Slackflow no longer removes a duplicate title or otherwise edits body text: selected source spans are kept verbatim and joined only with a deterministic blank line.

Before the live test, add these values to the local `.env` file (the file must remain uncommitted):

```text
LLM_PROVIDER=openai
LLM_MODEL=gpt-5.6-luna
LLM_REASONING_EFFORT=medium
```

Webflow remains disconnected.

`LLM_PROVIDER=anthropic` is intentionally rejected until its own native HTTP adapter is built and tested. This is deliberate: the design is provider-neutral, but it must not claim that an unavailable provider works.

## Next

### Step 6 — Read the exact Webflow CMS collection schema

**Status:** Blocked pending read-only Webflow collection access or a schema export

- Reviewed the official Webflow MCP and CMS Data API documentation on 2026-08-15.
- Confirmed that the current MCP CMS tool can list collections, return complete collection field details, and create items as drafts.
- Confirmed that the schema is required to map field slugs, types, required fields, option IDs, references, and rich-text format safely.
- Documented the required schema-first confirmation form and strict MCP action allowlist in `WEBFLOW_CMS_INTEGRATION.md`.
- Do not connect Webflow to the model directly: the MCP CMS tool includes update, publish, and delete actions in the same broad tool.
- Reviewed supplied Forge Blog Posts UI screenshots and recorded the visible field inventory plus a no-fabrication field policy in `WEBFLOW_CMS_INTEGRATION.md`.
- Identified visibly required fields: Name, Slug, Writer, and Tag. Name and Slug can be derived deterministically; Writer and Tag need an explicit business-default decision or values from the invoked Slack thread.
- Recorded the exact visible Tag options: NLP Labeling, Labeling, AI Industry, and Datasaur. Slackflow now has a closed-set, source-cited classification contract for these options, but actual option IDs still require the collection-schema read.
- Added and offline-tested a provider-neutral image-generation boundary plus the reviewed `prompts/image-generation.txt` template. The initial native HTTP adapter uses `gpt-image-2` and remains disconnected from Slack/Webflow, so this work made no paid image call and no CMS write.
- Restored the image prompt exactly as supplied. Only `{blog title}` and `{blog content}` are substituted at runtime. GPT Image 2 generates the documented 1536×1024 landscape source, then Slackflow exports the delivered Blog Image as an uncropped, pure-black-canvas 1920×1080 file.
- Added the combined Slack-only draft-and-image workflow. A single `@Slackflow draft` invocation generates one Blog Image only after the strict-transfer proposal is ready, then uploads the proposal, the full strict-transfer `.md` file, and the image into the same Slack reply. It does not generate an image for `needs_input` or `conflict`, and it makes no Webflow call.
- Added a minimal durable SQLite idempotency ledger. It claims the Slack event ID and command-message key before calling the model or image API, preventing delayed/repeated delivery from creating another draft or billed image. It retains only IDs, timestamps, and lifecycle state for 30 days.
- Corrected source-message filtering to remove the command itself and Slackflow's own replies by either bot user ID or bot ID. Logs now report fetched, excluded, and final source counts.
- Added 120-second bounds to the direct model and image API calls. Image-generation and Slack-upload failures now report separately.
- Added a compiled production start command, Dockerfile, and a minimal `GET /healthz` endpoint for hosted Docker health checks. `npm run check`, `npm run build`, and all 24 `npm test` cases pass locally after these changes.

### Step 7 — Enable Slack image-preview upload

**Status:** Pending one Slack app permission change

Before the live preview test:

1. Add the `files:write` bot token scope to Slackflow Dev under **OAuth & Permissions**.
2. Reinstall the app to the test workspace so the bot token receives that scope.
3. Restart `npm run dev`.
4. Create a fresh ready proposal with `@Slackflow draft`. It should post the strict-transfer proposal and attach the full `.md` draft plus one Blog Image in the same thread.

The bot must be a member of the target channel. A successful result will show one Markdown file and one image file in Slack and will make zero Webflow changes.

### Step 8 — Verify duplicate and review-file behavior

**Status:** Automated verification complete; live Slack verification pending

1. Restart `npm run dev` after this update so the persistent run ledger opens.
2. Send one fresh `@Slackflow draft` command. Verify the terminal's `messageCount` excludes the command and all Slackflow replies.
3. Confirm one Slack reply carries both `<title>-draft.md` and `<title>-blog-image.<format>`.
4. If Slack redelivers the same event, confirm the terminal says `Ignored duplicate Slackflow draft delivery` and Slack receives no second draft/image.
5. Automated checks now pass locally: `npm run check` and all 24 `npm test` cases.

### Step 9 — Select and validate the deployment state store

**Status:** Hosting decision required; Docker package is ready

- Added a generic `Dockerfile` and Hugging Face Docker-Space metadata to `README.md`.
- Documented the exact Hugging Face staging setup and the production recommendation in `DEPLOYMENT.md`.
- Hugging Face's default filesystem is ephemeral. A read/write Storage Bucket can retain the SQLite file at `/data/slackflow/state.sqlite`, but it has not been verified as a production-safe SQLite/WAL filesystem.
- For one always-on production worker, use a managed PostgreSQL database for the idempotency ledger before enabling more than one replica.
- Smoke-tested the compiled production app on an isolated local port: Socket Mode connected and `GET /healthz` returned HTTP 200 with `{"status":"ok"}`.

## Rules

- Never commit `.env` files.
- Never paste credentials into Slack, issue trackers, or chat messages.
- Use separate credentials for development, staging, and production.
