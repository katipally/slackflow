type OAuthPage = {
  detail: string;
  heading: string;
  success: boolean;
};

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

export function renderWebflowOAuthPage(page: OAuthPage): string {
  const heading = escapeHtml(page.heading);
  const detail = escapeHtml(page.detail);
  const state = page.success ? "success" : "error";
  const mark = page.success ? "✓" : "!";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${heading} | Slackflow</title>
    <style>
      :root { color-scheme: light dark; --canvas: #f5f7f7; --surface: #ffffff; --ink: #15201f; --muted: #5e6b69; --line: #d7e0de; --accent: #13745e; --error: #b5473d; }
      @media (prefers-color-scheme: dark) { :root { --canvas: #101716; --surface: #17201f; --ink: #ecf2f0; --muted: #aebbb8; --line: #34413f; --accent: #66c8ab; --error: #f28c83; } }
      * { box-sizing: border-box; }
      body { align-items: center; background: var(--canvas); color: var(--ink); display: flex; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; justify-content: center; margin: 0; min-height: 100dvh; padding: 24px; }
      main { max-width: 560px; width: 100%; }
      .brand { color: var(--muted); font-size: 14px; font-weight: 700; letter-spacing: .08em; margin: 0 0 28px; text-transform: uppercase; }
      .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: clamp(28px, 6vw, 48px); }
      .mark { align-items: center; background: color-mix(in srgb, var(--accent) 14%, transparent); border-radius: 999px; color: var(--accent); display: flex; font-size: 24px; font-weight: 800; height: 48px; justify-content: center; margin-bottom: 22px; width: 48px; }
      .error .mark { background: color-mix(in srgb, var(--error) 14%, transparent); color: var(--error); }
      h1 { font-size: clamp(30px, 6vw, 42px); letter-spacing: -.045em; line-height: 1.05; margin: 0; }
      p { color: var(--muted); font-size: 17px; line-height: 1.55; margin: 16px 0 0; }
      .note { border-top: 1px solid var(--line); font-size: 14px; margin-top: 28px; padding-top: 20px; }
      .button { background: var(--ink); border-radius: 10px; color: var(--surface); display: inline-block; font: inherit; font-weight: 700; margin-top: 28px; padding: 12px 16px; text-decoration: none; }
      .button.secondary { background: transparent; border: 1px solid var(--line); color: var(--ink); cursor: pointer; margin-left: 8px; }
      .button:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
      .button:active { transform: translateY(1px); }
    </style>
  </head>
  <body>
    <main class="${state}">
      <p class="brand">Slackflow</p>
      <section class="panel" aria-live="polite">
        <div class="mark" aria-hidden="true">${mark}</div>
        <h1>${heading}</h1>
        <p>${detail}</p>
        <p class="note">The original Slack confirmation has been updated. If Slack does not open from the button, switch back to its tab or app manually.</p>
        <a class="button" href="slack://open">Open Slack</a>
        <button class="button secondary" type="button" onclick="window.close()">Close tab</button>
      </section>
    </main>
  </body>
</html>`;
}
