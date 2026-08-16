# Deployment

Slackflow is deployed as a Node web service on Render. It does not use Docker.

The complete setup instructions are in [README.md](README.md), including Slack app setup, Render environment values, the `/healthz` check, UptimeRobot, and the current Webflow MCP status.

For this demo:

- Run one Render web service from the `main` branch.
- Use `npm ci && npm run build` as the build command.
- Use `npm start` as the start command.
- Monitor `https://slackflow-demo.onrender.com/healthz` with UptimeRobot every five minutes.
- Keep all credentials in Render Environment settings and out of Git.
- Expect local SQLite state to be lost if the free service restarts, redeploys, or spins down.

The bot uses Socket Mode. It needs no public Slack Events URL.
