# Deploying Slackflow

Slackflow is a long-running **Slack Socket Mode worker**. It opens an outbound connection to Slack; it does not need a public Slack Events URL. The container also serves `GET /` and `GET /healthz` on `PORT` for its host's health check.

## Recommended production shape

Run exactly one always-on Docker instance and use a managed PostgreSQL database for the idempotency ledger when production reliability or horizontal scaling matters. The table is deliberately tiny: event ID, command key, status, and timestamps.

The checked-in SQLite store is suitable for local development and a single-instance test deployment only when its database is on a filesystem that is known to support SQLite locking and survives restarts. Do not share one SQLite file across replicas.

## Hugging Face Spaces

Hugging Face can run Slackflow as a Docker Space, but it is a reasonable **staging** host rather than the preferred production host:

- Free CPU Spaces sleep after inactivity, which stops the Socket Mode connection. A Slack bot that must respond at any time needs an always-on paid runtime.
- The default Docker-Space disk is ephemeral. An attached Storage Bucket is read/write and persists its files, but its documentation does not promise the SQLite/WAL locking guarantees required for a production idempotency database. Use PostgreSQL for production duplicate protection.

If you are deliberately testing one single Space with SQLite:

1. Create a **Docker** Space from this repository and set its app port to `7860`.
2. Create and attach a read/write Storage Bucket at `/data` in the Space settings.
3. Add these values in the Space's **Secrets** settings, never in Git: `SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and `OPENAI_API_KEY`.
4. Add these non-secret variables:

   ```text
   PORT=7860
   LLM_PROVIDER=openai
   LLM_MODEL=gpt-5.6-luna
   LLM_REASONING_EFFORT=medium
   IMAGE_PROVIDER=openai
   IMAGE_MODEL=gpt-image-2
   # GPT Image 2 source size; Slackflow exports the delivered file at 1920x1080.
   IMAGE_BLOG_SIZE=1536x1024
   IMAGE_QUALITY=medium
   IMAGE_OUTPUT_FORMAT=jpeg
   SLACKFLOW_STATE_PATH=/data/slackflow/state.sqlite
   ```

5. Confirm the build logs show Slackflow connected, then invoke `@Slackflow draft` in the Slack test channel. Verify that `GET /healthz` returns `{"status":"ok"}`.

The `Dockerfile` runs the compiled app as the non-root `node` user. It contains no credentials and does not create or configure a Webflow connection.

## Production readiness checklist

1. Use Node 22.13 or newer (the built-in SQLite API requires it); the Docker image uses Node 24.
2. Keep exactly one worker until the run store has been replaced with Postgres.
3. Keep every credential in the host's secrets manager and rotate development keys before production.
4. Use a host that will not sleep while the bot is expected to serve Slack.
5. After deploying, test one ready thread, one incomplete thread, an image-generation failure, a Slack file-upload failure, and a process restart.
6. Do not enable the Webflow MCP/write workflow until the collection schema has been read and the documented confirmation gate is implemented.
