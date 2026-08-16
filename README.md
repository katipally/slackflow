# Slackflow

Slackflow reads the full context of a Slack thread and prepares a blog draft for review.

Use it inside a Slack thread:

```text
@slackflow draft
```

## Commands

| Command | Available now | Result |
| --- | --- | --- |
| `@slackflow draft` | Yes | Creates the strict-transfer Slack review, Markdown file, and image preview. It does not write to Webflow. |
| `@slackflow help` | Yes | Shows this command set in Slack. |
| `@slackflow status` | Yes | Shows the current Slackflow and Webflow connection state without exposing secrets. |
| `@slackflow connect` | Yes, after Render configuration | Sends a private one-time Webflow OAuth link. |
| `@slackflow schema` | Recognized | Explains that schema discovery is unavailable until Webflow MCP is connected. |
| `@slackflow disconnect` | Yes | Removes Slackflow's encrypted local Webflow connection. It does not revoke the OAuth grant in Webflow. |

Only exact compact commands are accepted. For example, `@slackflow create a Webflow draft` does not trigger any action.

## What works today

- Reads the root message and replies posted before the command from every participant.
- Removes the command and Slackflow's own messages from the source.
- Transfers article text only from exact Slack source text. It does not invent, rewrite, or improve the article.
- Posts a review proposal, a Markdown draft file, and one 1920x1080 Blog Image in Slack.
- Uses `gpt-5.6-luna` through a small provider adapter and `gpt-image-2` for the image preview.
- Does not create, edit, publish, or otherwise change anything in Webflow.

If the thread does not contain enough exact source text, Slackflow returns `needs_input` instead of making content up.

## Webflow MCP status

Slackflow now contains the OAuth connection flow for Webflow MCP. It has not yet been tested against your Webflow account, and CMS schema reading and Webflow draft creation are still disabled. The MCP endpoint is:

```text
https://mcp.webflow.com/mcp
```

The planned flow is simple:

```text
@slackflow connect
  -> Receive a private one-time link in Slack
  -> Complete Webflow OAuth in the browser
  -> Run @slackflow status to confirm the local connection

@slackflow draft
  -> Review the exact transferred draft and image in Slack
  -> No Webflow CMS action yet
```

There is no individual approver allowlist for this demo. When this flow is built, anyone in the Slack workspace who can use the bot can start it. The create action will still require an explicit Slack confirmation and will create a draft only. It will never publish automatically.

## Local setup

Requirements: Node 22.13 or newer and a Slack workspace where you can create an app.

1. Copy `.env.example` to `.env`.
2. Set the Slack credentials and OpenAI API key in `.env`. Never commit or share that file.
3. Install and check the project:

   ```bash
   npm install
   npm run check
   npm test
   ```

4. Start the bot:

   ```bash
   npm run dev
   ```

5. In a test channel, create a message with replies, then post `@slackflow draft` as a reply in that thread.

### Required environment values

```text
SLACK_SIGNING_SECRET=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
OPENAI_API_KEY=

LLM_PROVIDER=openai
LLM_MODEL=gpt-5.6-luna
LLM_REASONING_EFFORT=medium

IMAGE_PROVIDER=openai
IMAGE_MODEL=gpt-image-2
IMAGE_BLOG_SIZE=1536x1024
IMAGE_QUALITY=medium
IMAGE_OUTPUT_FORMAT=jpeg

PUBLIC_BASE_URL=https://slackflow-demo.onrender.com
WEBFLOW_MCP_URL=https://mcp.webflow.com/mcp
WEBFLOW_TOKEN_ENCRYPTION_KEY=
```

The image model creates a 1536x1024 source image. Slackflow places it without cropping on a black 1920x1080 canvas before uploading it to Slack.

## Slack app setup

1. Create a Slack app from scratch in your workspace.
2. Turn on **Socket Mode** and create an app-level token with the `connections:write` scope. Put it in `SLACK_APP_TOKEN`.
3. Under **OAuth & Permissions**, add these bot token scopes:

   ```text
   app_mentions:read
   channels:history
   groups:history
   chat:write
   files:write
   ```

4. Under **Event Subscriptions**, subscribe to the `app_mention` bot event.
5. Install the app to the workspace. Copy the bot token to `SLACK_BOT_TOKEN` and the signing secret to `SLACK_SIGNING_SECRET`.
6. Invite the bot to each test channel. It must be invited to private channels before it can read their threads.

Socket Mode means Slackflow does not need a public Slack Events URL. It opens an outbound connection to Slack.

## Deploy on Render without Docker

This repository is deployed as a Node web service from the `main` branch of [katipally/slackflow](https://github.com/katipally/slackflow). No Docker setup is required.

1. In Render, create a **Web Service** from the GitHub repository.
2. Choose the Node runtime and the `main` branch.
3. Set the build command:

   ```text
   npm ci && npm run build
   ```

4. Set the start command:

   ```text
   npm start
   ```

5. Add the same secret environment values listed above in Render's Environment page. Set `PUBLIC_BASE_URL` to `https://slackflow-demo.onrender.com`. Generate `WEBFLOW_TOKEN_ENCRYPTION_KEY` with `openssl rand -base64 32` and store its output only in Render. Do not add `.env` or this key to Git.
6. Deploy. Render provides `PORT`; Slackflow listens on it and exposes these checks:

   ```text
   GET /
   GET /healthz
   ```

7. Check the Render logs for the Socket Mode connection, then run `@slackflow draft` in the Slack test thread.

The current Render URL is `https://slackflow-demo.onrender.com/`.

### UptimeRobot

Create one HTTP(S) monitor for:

```text
https://slackflow-demo.onrender.com/healthz
```

Use UptimeRobot's available five-minute interval. Your monitor is currently up. These requests help avoid Render's 15-minute idle timeout during the demo, but they do not guarantee that a free Render service will never restart.

Render Free has an ephemeral filesystem. The local SQLite run ledger can be lost after a restart, redeploy, or spin-down. That is acceptable for this demo, but any future Webflow OAuth connection may need to be reconnected after one of those events.

## Webflow MCP boundaries

Slackflow uses the MCP TypeScript client and Webflow's OAuth server. The local SQLite store encrypts OAuth tokens, dynamic client information, PKCE data, and OAuth discovery state using `WEBFLOW_TOKEN_ENCRYPTION_KEY`. The one-time browser link expires after ten minutes.

Slackflow will use Webflow MCP through deterministic application code, not as unrestricted model tools. The current code establishes OAuth only. A later schema feature will read the exact CMS collection schema and map only fields that exist in that schema. It will stop if a required field has no valid value.

The future writer will create a CMS item as a draft only and then verify it. It will not call publish, update, or delete actions. See [WEBFLOW_CMS_INTEGRATION.md](WEBFLOW_CMS_INTEGRATION.md) for the full technical contract.

## Helpful links

- [Slack app quickstart](https://docs.slack.dev/quickstart/)
- [Render web services](https://render.com/docs/web-services)
- [Render Free limits](https://render.com/docs/free)
- [UptimeRobot](https://uptimerobot.com/)
- [Webflow MCP getting started](https://developers.webflow.com/mcp/reference/getting-started)
