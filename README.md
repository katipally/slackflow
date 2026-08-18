# Slackflow

Slackflow is a Slack bot that turns the complete context of an invoked thread into a reviewed Webflow CMS draft. It uses strict transfer: article text must come from exact text selected from Slack. It does not invent, rewrite, or improve the blog post.

The normal workflow is:

1. Connect Webflow once.
2. Choose a Webflow site and CMS collection once.
3. In any source thread, run `@slackflow draft`.
4. Review the generated Markdown, thumbnail, and banner in the same Slack thread.
5. Click **Create Webflow draft** to create one unpublished CMS item.

Slackflow never calls a publish, update, or delete action.

Setting the service up, or keeping it running, is in [DEPLOY.md](DEPLOY.md). This file covers what it does and how to use it.

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

## Connecting Webflow

Do this once, in any Slack thread, after the service is deployed.

1. Run `@slackflow connect`.
2. Open the private **Connect Webflow** link and approve Webflow OAuth.
3. Return to the same Slack thread. Slackflow edits its connection message to confirm success.
4. Run `@slackflow schema`.
5. Choose the target Webflow site.
6. Choose the target CMS collection, for example **Forge Blog Posts**.

This is read-only. Slackflow captures the selected collection's real fields, field types, required rules, valid Tag option IDs, and a schema fingerprint, and builds a draft contract from them. No CMS item is created during `connect` or `schema`.

When the target collection changes, run `@slackflow schema` again and choose the new one.

## Regular use

1. Place the source blog content in a Slack thread. Multiple people and multiple replies are supported.
2. Post `@slackflow draft` as a reply in that thread. Slackflow posts its progress while it works.
3. Read the attached Markdown and inspect the thumbnail and banner.
4. If the text is right but the image is not, click **Regenerate image**. It generates a new thumbnail and banner from the same reviewed text and leaves the draft text untouched.
5. When both are correct, click **Create Webflow draft** in the same thread.
6. Slackflow creates a new unpublished CMS item and replies with the item ID and an **Open in Webflow** button.

A review stays usable for 24 hours, and survives a service restart when the service has persistent storage (see [DEPLOY.md](DEPLOY.md)).

If a create request fails without a clear answer, press the same button again. Slackflow records each attempt, so on a retry it first checks whether the earlier attempt actually reached Webflow and reports that item instead of creating a second one. A first press is never blocked: Webflow assigns the slug and keeps it unique by itself, so two posts may share a title.

Webflow's API returns no per-item editor URL, so **Open in Webflow** opens the Designer for the target site. The draft is the newest item in the selected collection.

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

On confirmation, Slackflow creates one new unpublished CMS item, fills only validated fields, assigns Writer to `Datasaur`, and uses verified Tag and Category values. The banner goes to Main Image and the 1920x1080 file goes to Thumbnail Image.

## Safety boundaries

- Slackflow creates only new CMS items. It does not search for and modify existing items.
- It requests an unpublished draft and never calls Webflow publish, update, archive, or delete actions.
- The create button is shown only after the selected CMS schema validates the proposed mapping.
- The schema is checked again before creation.
- Only verified CMS option IDs are used for select fields.
- OAuth tokens are encrypted at rest and never shown in Slack messages or logs.

## When something looks wrong

| Symptom | What to do |
| --- | --- |
| Slackflow ignores a mention | Invite the bot to the channel. |
| Bot cannot read a private thread | Invite the bot to that private channel. |
| Create button is not shown | The captured collection cannot safely map this draft. The reply gives the reason; the Markdown review file shows the exact field mapping. Run `@slackflow schema` if the target collection changed. |
| A create request may have timed out | Press the same button again. Slackflow checks whether that attempt reached Webflow and reports the item it made, instead of creating a second one. |
| The review says it expired | Reviews last 24 hours. Run `@slackflow draft` again. |
| `connect` or `schema` fails | Run `@slackflow status`. If it reports the Webflow connection missing or the service degraded, hand the reply to whoever operates the service and see [DEPLOY.md](DEPLOY.md). |

## Development

```bash
git clone https://github.com/katipally/slackflow.git
cd slackflow
cp .env.example .env      # values are documented in DEPLOY.md
npm install
npm run check
npm test
npm run build
npm run dev
```

Then invite the bot to a test channel, create a thread with source content, and post `@slackflow draft` as a reply.

Slack works locally over Socket Mode, but Webflow OAuth needs a public HTTPS `PUBLIC_BASE_URL`, so run `connect` and `schema` against the deployed service.

Requirements: Node.js 22.13 or newer, a Slack workspace you can install an app into, an OpenAI API key, and a Webflow account with access to the target site.

Reference: [Webflow MCP getting started](https://developers.webflow.com/mcp/reference/getting-started).
