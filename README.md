# Slackflow

Slackflow is a Slack bot that turns the complete context of an invoked thread into a reviewed Webflow CMS draft. It uses strict transfer: article text must come from exact text selected from Slack. It does not invent, rewrite, or improve the blog post.

The normal workflow is:

1. Connect Webflow once.
2. Choose a Webflow site and CMS collection once.
3. In any source thread, run `@slackflow draft`.
4. Review the generated Markdown, thumbnail, and banner in the same Slack thread.
5. Click **Create Webflow draft** to create one unpublished CMS item.

Slackflow never calls a publish, update, or delete action.

## Commands

| Command | When to use it | What it does |
| --- | --- | --- |
| `@slackflow connect` | First setup or after lost storage | Sends a private one-time Webflow OAuth link. |
| `@slackflow schema` | First setup or changing target site or collection | Lets you choose a Webflow site and collection, then reads its exact fields and validation rules. |
| `@slackflow draft` | Regular workflow, in a source thread | Reads the thread, creates review files, and shows **Create Webflow draft** when the selected CMS contract validates. |
| `@slackflow status` | Troubleshooting | Shows connection and readiness state without exposing secrets. |
| `@slackflow disconnect` | Replacing or removing the Webflow connection | Removes Slackflow's locally encrypted OAuth connection. It does not revoke the grant in Webflow. |
| `@slackflow help` | Any time | Shows the command list in Slack. |

Use only these compact commands. For example, `@slackflow create a Webflow draft` is intentionally ignored.

## What `draft` does

Slackflow reads the root message and replies posted before the command. It excludes the command itself, Slackflow messages, and later thread messages.

The text-model adapter selects exact source passages. Slackflow then applies deterministic safeguards:

- Outer Markdown wrappers on a title, such as `_Title_` or `*Title*`, become plain title text.
- A trailing assistant menu beginning with `If you want, I can also:` is excluded from the post body.
- Headings are preserved when the source supplies an unambiguous heading signal.
- Missing source data stays missing. Slackflow does not fabricate it.

For a valid review, it uploads these files to Slack:

- A Markdown file containing the full draft and CMS field values.
- A 1920x1080 thumbnail image.
- A 1920x640 banner image derived from the same reviewed image.

On confirmation, Slackflow creates one new unpublished CMS item, fills only validated fields, assigns Writer to `Datasaur`, and uses verified Tag and Category values. The banner goes to Main Image and the 1920x1080 file goes to Thumbnail Image for the selected Forge Blog Posts workflow.

## Requirements

- Node.js 22.13 or newer.
- A Slack workspace where you can create and install an app.
- An OpenAI API key for the configured text and image providers.
- A Webflow account with access to the target site and CMS collection.
- A publicly reachable HTTPS origin for Webflow OAuth in production.

## Local setup

1. Clone the repository and enter it.

   ```bash
   git clone https://github.com/katipally/slackflow.git
   cd slackflow
   ```

2. Copy the environment template and fill in values.

   ```bash
   cp .env.example .env
   ```

3. Install, verify, and run the bot.

   ```bash
   npm install
   npm run check
   npm test
   npm run build
   npm run dev
   ```

4. Invite the bot to a test channel, create a thread with source content, and post `@slackflow draft` as a reply in that thread.

For a local bot test, the Slack app can use Socket Mode. Webflow OAuth still needs a public HTTPS `PUBLIC_BASE_URL`, so use the deployed service for `connect` and `schema`.

### Environment values

Copy every value from `.env.example`. The important production values are:

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

PUBLIC_BASE_URL=https://your-service.example.com
WEBFLOW_MCP_URL=https://mcp.webflow.com/mcp
WEBFLOW_TOKEN_ENCRYPTION_KEY=
SLACKFLOW_STATE_PATH=.slackflow/state.sqlite
```

Generate `WEBFLOW_TOKEN_ENCRYPTION_KEY` once, keep it secret, and do not rotate it while you need existing local OAuth connections:

```bash
openssl rand -base64 32
```

Do not commit `.env`, OAuth tokens, Slack tokens, or this encryption key.

## Slack app setup

1. Go to [Slack API Apps](https://api.slack.com/apps) and create an app from scratch in the target workspace.
2. Open **Socket Mode**, enable it, and create an app-level token with this scope:

   ```text
   connections:write
   ```

   Put that token in `SLACK_APP_TOKEN`.

3. Open **OAuth & Permissions** and add these Bot Token Scopes:

   ```text
   app_mentions:read
   channels:history
   groups:history
   chat:write
   files:write
   ```

4. Open **Event Subscriptions** and subscribe to the bot event:

   ```text
   app_mention
   ```

5. Install or reinstall the app to the workspace. Copy the Bot User OAuth Token to `SLACK_BOT_TOKEN` and the signing secret to `SLACK_SIGNING_SECRET`.
6. Invite the bot to every channel it should read. For private channels, it must be invited before it can access thread history.

Socket Mode uses an outbound connection to Slack, so Slack does not need a public Events Request URL.

If you add or change a Slack scope, reinstall the app before testing it.

## First Webflow setup

Do this in any Slack thread after the backend is deployed and `PUBLIC_BASE_URL` is correct.

1. Run `@slackflow connect`.
2. Open the private **Connect Webflow** link and approve Webflow OAuth.
3. Return to the same Slack thread. Slackflow edits its connection message to confirm success.
4. Run `@slackflow schema`.
5. Choose the target Webflow site.
6. Choose the target CMS collection, for example **Forge Blog Posts**.

This is read-only. Slackflow captures the selected collection's real fields, field types, required rules, valid Tag option IDs, and a schema fingerprint. It creates a draft contract from that information. No CMS item is created during `connect` or `schema`.

When the collection changes, run `@slackflow schema` again and choose the new target.

## Regular use

1. Place the source blog content in a Slack thread. Multiple people and multiple replies are supported.
2. Post `@slackflow draft` as a reply in that thread.
3. Read the attached Markdown and inspect the thumbnail and banner.
4. If they are correct, click **Create Webflow draft** in the same thread.
5. Slackflow creates a new unpublished CMS item and replies with the result. Open the returned Webflow link to review it.

Do not use the same button repeatedly. If a request times out, check Webflow for the new item before retrying to avoid creating duplicates.

## Hosting the agent backend

Slackflow is a long-running agent backend, not a static website. The host needs:

- A persistent Node process for Slack Socket Mode.
- A public HTTPS origin for Webflow OAuth redirects.
- Secret environment variables.
- A writable state path if you want OAuth connections and duplicate-delivery records to survive restarts.

It exposes these health endpoints:

```text
GET /
GET /healthz
```

### Render example, without Docker

This repository can run as a Render Node Web Service.

1. Create a **Web Service** from the GitHub repository and select the `main` branch.
2. Choose the Node runtime.
3. Set the build command:

   ```text
   npm ci && npm run build
   ```

4. Set the start command:

   ```text
   npm start
   ```

5. Add the environment values above in Render's Environment page. Set `PUBLIC_BASE_URL` to the exact Render HTTPS origin, for example `https://your-service.onrender.com`.
6. Deploy and check the logs for `Slackflow is running in Socket Mode`.
7. Use `https://your-service.onrender.com/healthz` for a health check.

Render provides `PORT` automatically and Slackflow uses it. No Dockerfile is required.

### Storage and free hosts

Slackflow stores an encrypted Webflow OAuth connection and a small duplicate-delivery ledger in SQLite at `SLACKFLOW_STATE_PATH`. The CMS drafts themselves are stored in Webflow, not SQLite.

Free Render services have an ephemeral filesystem. A restart, redeploy, or spin-down can remove the SQLite file. The result is that `@slackflow connect` and possibly `@slackflow schema` must be run again. Existing Webflow drafts are not affected.

For a short demo, this is acceptable. For reliable use, attach persistent storage or use a durable database and object storage for the state file. Keep the same `WEBFLOW_TOKEN_ENCRYPTION_KEY`, or existing encrypted tokens cannot be read.

An UptimeRobot HTTP(S) monitor can request `/healthz` every five minutes during a demo. It may reduce idle time on some free services, but it does not make free hosting durable or guarantee continuous uptime.

## Safety boundaries

- Slackflow creates only new CMS items. It does not search for and modify existing items.
- It requests an unpublished draft and never calls Webflow publish, update, archive, or delete actions.
- The create button is shown only after the selected CMS schema validates the proposed mapping.
- The schema is checked again before creation.
- Only verified CMS option IDs are used for select fields.
- OAuth tokens are encrypted locally and never shown in Slack messages or logs.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Bot cannot read a private thread | Invite the bot to the private channel and reinstall it if you just added `groups:history`. |
| `connect` does not open OAuth | Check `PUBLIC_BASE_URL` is the deployed HTTPS origin with no extra path, then redeploy. |
| `schema` is unavailable | Run `@slackflow connect`, complete OAuth, then run `@slackflow schema` in the same Slack thread. |
| Create button is not shown | Ensure `schema` has captured the right collection and that required fields have valid source values. Read the Markdown review file for the exact field mapping. |
| Webflow connection disappeared after deploy | The host likely lost ephemeral SQLite state. Run `@slackflow connect` and then `@slackflow schema` again. |
| A create request may have timed out | Check Webflow for a new draft before pressing the button again. |

## Verification commands

Run these before deployment:

```bash
npm run check
npm test
npm run build
```

## Useful links

- [Slack app quickstart](https://docs.slack.dev/quickstart/)
- [Webflow MCP getting started](https://developers.webflow.com/mcp/reference/getting-started)
- [Render web services](https://render.com/docs/web-services)
- [Render free services](https://render.com/docs/free)
- [UptimeRobot](https://uptimerobot.com/)
