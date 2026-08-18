# Slackflow deployment

Repo: https://github.com/katipally/slackflow
Reference deployment: https://slackflow-demo.onrender.com

What the bot does and how it is used is in [README.md](README.md). This file is setup and operations only.

```
 Slack workspace                  Host (Node process)              Webflow
 ---------------                  -------------------              -------
 @slackflow draft  --socket-->  slackflow  --OAuth/MCP-->  CMS draft (unpublished)
                                    ^  |
                   uptime ping ------+  +--> GET /healthz
```

## 1. What the host must provide

- One always-on Node 22.13+ process (Slack Socket Mode holds an outbound WebSocket).
- A public HTTPS origin, used only for the Webflow OAuth redirect.
- Environment variables as secrets.
- A writable path for `SLACKFLOW_STATE_PATH`. Persistent disk if it should survive restarts.

Build `npm ci && npm run build`, start `npm start`, port read from `PORT`.

## 2. Environment variables

Required:

| Key | Value |
| --- | --- |
| `SLACK_APP_TOKEN` | App-level token, scope `connections:write` (`xapp-…`) |
| `SLACK_BOT_TOKEN` | Bot User OAuth Token (`xoxb-…`) |
| `OPENAI_API_KEY` | Text + image generation |
| `PUBLIC_BASE_URL` | Exact HTTPS origin, no trailing path or slash |
| `WEBFLOW_TOKEN_ENCRYPTION_KEY` | `openssl rand -base64 32`, set once, never rotate while a connection exists |

Slackflow answers in every channel it is invited to. Control access by controlling the invite.

Defaults, override only to change models or storage:

```text
LLM_PROVIDER=openai
LLM_MODEL=gpt-5.6-luna
LLM_REASONING_EFFORT=medium
IMAGE_PROVIDER=openai
IMAGE_MODEL=gpt-image-2
IMAGE_BLOG_SIZE=1536x1024
IMAGE_QUALITY=medium
IMAGE_OUTPUT_FORMAT=jpeg
WEBFLOW_MCP_URL=https://mcp.webflow.com/mcp
SLACKFLOW_STATE_PATH=.slackflow/state.sqlite
NODE_ENV=production
```

`.env.example` carries the same list for local use. Never commit `.env`, Slack tokens, the OpenAI key, or the encryption key.

No Webflow API key is stored in env. Webflow access is granted per workspace by `@slackflow connect` (OAuth) and held encrypted at `SLACKFLOW_STATE_PATH`.

## 3. Slack app

1. api.slack.com/apps, create from scratch in the workspace.
2. Socket Mode: enable, create app-level token with `connections:write` → `SLACK_APP_TOKEN`.
3. OAuth & Permissions, bot token scopes:

   ```text
   app_mentions:read
   channels:history
   groups:history
   chat:write
   files:write
   ```

   `reactions:write` is optional. With it, Slackflow marks the mention with :eyes: while a draft runs.

4. Event Subscriptions, bot event `app_mention`. No Request URL needed; Socket Mode is outbound.
5. Install to workspace → `SLACK_BOT_TOKEN`. Socket Mode verifies nothing by signature, so the app's signing secret is not needed.
6. Invite the bot to every channel it reads, including private ones.

Reinstall the app after any scope change.

## 4. Hosting

Any host that runs a persistent Node process works: Render, Railway, Fly.io, ECS, a VM with systemd. The only hard requirements are section 1.

What we used, for cost:

- Render Web Service, Node runtime, free instance, deploy from `main`.
  - Build and start commands from section 1. Render supplies `PORT`; no Dockerfile needed.
  - Env values from section 2, `PUBLIC_BASE_URL=https://<service>.onrender.com`.
- UptimeRobot HTTP(S) monitor on `https://<service>.onrender.com/healthz` every 5 minutes to reduce idle spin-down.

### State and the free-tier tradeoff

SQLite at `SLACKFLOW_STATE_PATH` holds the encrypted Webflow OAuth connection, the captured CMS schema, reviews waiting for their Create button, and a duplicate-delivery ledger. Drafts themselves live in Webflow, not here.

Free instances have an ephemeral filesystem, so a redeploy or spin-down can drop that file. Effect: re-run `@slackflow connect` and `@slackflow schema`, and regenerate any review still waiting for approval. Existing Webflow drafts are unaffected.

For production, use a paid instance with a persistent disk mounted at `SLACKFLOW_STATE_PATH`, and keep `WEBFLOW_TOKEN_ENCRYPTION_KEY` unchanged or the stored tokens become unreadable.

Uptime pings are a cost workaround, not a durability guarantee.

## 5. Health checks

```text
GET /
GET /healthz
```

Both return live state rather than a fixed `ok`:

```json
{"status":"ok","slack":"connected","webflow":"connected","uptimeSeconds":1042}
```

`slack` is `connected`, `starting`, `reconnecting`, or `disconnected`. The status code is 503 once the socket has been down for more than 90 seconds, so a monitor fails when the bot is actually down rather than during Socket Mode's own routine reconnects.

## 6. Verify a deployment

1. Logs show `Slackflow is running in Socket Mode`.
2. `curl https://<origin>/healthz` returns 200 with `"slack":"connected"`.
3. In Slack: `@slackflow status`.

Before deploying, run `npm run check && npm test && npm run build`.

Webflow linking (`connect` → `schema` → `draft`) is covered in [README.md](README.md) and the walkthrough video.

## 7. Operator troubleshooting

| Symptom | What to check |
| --- | --- |
| `/healthz` returns 503 | Slack socket disconnected. Check logs and that `SLACK_APP_TOKEN` still has `connections:write`. |
| `connect` does not open OAuth | `PUBLIC_BASE_URL` must be the deployed HTTPS origin with no extra path or trailing slash. Redeploy after changing it. |
| Webflow connection disappeared after a deploy | Ephemeral disk lost the SQLite state. Re-run `@slackflow connect` and `@slackflow schema`, then move the state path to a persistent disk. |
| Bot ignores a channel | It was never invited to that channel. |
| Bot cannot read a private channel it was invited to | Reinstall the app if `groups:history` was added after installation. |
| Draft runs fail on the image step | Check the OpenAI key and quota in the service logs. No Webflow change happens in that path. |

## Useful links

- [Render web services](https://render.com/docs/web-services)
- [Render free services](https://render.com/docs/free)
- [UptimeRobot](https://uptimerobot.com/)
- [Slack app quickstart](https://docs.slack.dev/quickstart/)
