# Webflow CMS Draft Integration Contract

**Status:** schema discovery required before implementation. No Webflow credentials, MCP connection, CMS schema, or write capability has been added to Slackflow.

**Verified on:** 2026-08-15

## Terminology

Webflow's current CMS Data API uses `/v2` endpoints. The Webflow MCP server is a separate integration layer built on Webflow APIs; it is not a product named “Webflow MCP 2.0”.

## Verified MCP workflow

The official Webflow MCP CMS tool (`data_cms_tool`) can:

1. List a site's collections with `get_collection_list`.
2. Read the exact fields, types, slugs, validation rules, and option/reference IDs for one collection with `get_collection_details`.
3. Create an item with `create_collection_items`; Webflow documents these MCP-created items as drafts, with live publishing a separate action.

The schema read is mandatory. We will not infer field names such as `blog-body`, `publish-date`, or `author` from screenshots, labels, or another CMS.

## Critical safety constraint

Webflow documents access at the MCP **tool** level. `data_cms_tool` contains actions that can create, update, publish, unpublish, and delete CMS content. Therefore:

- The model provider receives no Webflow/MCP tools and cannot select action names.
- Slackflow's deterministic application code will have a fixed allowlist: `get_collection_list`, `get_collection_details`, and, after Slack approval, `create_collection_items` for one configured collection ID.
- It will never use `publish_collection_items`, `update_collection_items`, `delete_collection_items`, or collection/field-creation actions.
- The target site and collection ID will be fixed per environment; no value from Slack or the model can select a destination.

## Remote MCP connection gate

The configured MCP endpoint is `https://mcp.webflow.com/mcp`. A real connection is **not** active in the current local bot, because Webflow requires an account owner to authorize site access through OAuth. This is a deliberate authorization boundary, not a missing value that Slackflow should bypass.

The production implementation will connect in this order:

1. Deploy Slackflow at a stable HTTPS origin and register/configure its OAuth callback in the MCP client implementation.
2. An authorized Webflow user completes the browser OAuth consent and selects the allowed site(s).
3. Store refresh/access credentials encrypted outside the repository; never in Slack, `.env.example`, logs, or model context.
4. From deterministic code, call only `get_collection_list` and `get_collection_details` to capture the target site, collection, primary locale, field definitions, option IDs, reference IDs, and a schema fingerprint.
5. Display the generated confirmation form in Slack. On an authorized explicit approval only, call `create_collection_items` for the fixed collection, then read back and verify the resulting item is still a draft.

The image path is deliberately separate: after the approved `gpt-image-2` call returns image bytes, deterministic code uses `data_assets_tool.create_asset`, uploads those bytes to Webflow's returned presigned target, and only then places the returned asset reference into an explicitly approved CMS image field. No model gets a broad Webflow MCP tool, and no generated image becomes a CMS asset automatically.

## Required collection-inspection result

Before a draft can be created, Slackflow must store an approved configuration with:

```text
site ID
collection ID
collection display name
schema hash/version
every field: ID, slug, display name, type, required flag, validations
option IDs and referenced collection IDs where applicable
primary CMS locale
an explicit approved mapping from Slackflow fields to Webflow field slugs
```

Webflow's system fields `name` and `slug` are required for CMS items. Any additional required field in the selected collection must have an explicit approved mapping or Slackflow stops with `needs_input`—it does not invent a value.

## Strict-transfer source rule

Before it reaches this writer, Slackflow's model output contains source selections rather than free-form CMS values. Each non-null selection has an exact text span and the timestamp of the captured Slack message that contains it. Slackflow locally rejects any text that is not a character-for-character source substring, any unknown timestamp, a changed ordering of body spans, or an attempted `compose` response. It then derives the reviewed values deterministically. Therefore the later Webflow writer receives only verified transfer text, never model-authored article prose.

## Draft confirmation form

Once the schema is available, Slackflow will show this form in the invoked Slack thread before any write:

```text
Webflow CMS draft confirmation — no write yet

Destination: <site> / <collection>
Schema: <collection ID + schema hash>

Webflow field                  Type         Source / proposed value
name                           PlainText    Slackflow title
slug                           PlainText    <approved deterministic slug>
<actual body field slug>       RichText     <HTML converted from reviewed body>
<actual date field slug>       DateTime     <thread value or blank>
<actual source field slug>     Link         <thread value or blank>
<actual image field slug>      Image        blank — a text brief is not an image asset
<each remaining required field> <actual>    mapped value or BLOCKED

State: draft only; never publish
Action: Create draft / Cancel
```

The rows are generated from the returned schema, not hard-coded. A Rich Text field requires HTML rather than the current `body_markdown`; Slackflow will use a deterministic, tested conversion only after the actual field type is known. An Option field uses its schema option ID, and a Reference field uses an existing item ID—never a label guessed by the model.

## Provisional Forge Blog Posts inventory from UI screenshots

The supplied Webflow Designer screenshots show these fields. This is a content policy, not an API schema: Webflow field slugs, exact types, option IDs, reference targets, and validation limits still need a `get_collection_details` read.

| Visible field | UI evidence | Slackflow policy |
|---|---|---|
| Name | Required | Set from the reviewed Slackflow title. |
| Slug | Required | Generate deterministically from the approved title; check for an existing collision before writing. |
| Post Body | Rich-text editor UI | Set from the reviewed body after deterministic Markdown-to-safe-HTML conversion. Never repeat the separate title as the first heading. |
| Post Summary | Blog-grid help text | Leave blank unless the thread explicitly supplies an approved summary. Do not invent a marketing summary. |
| Main Image | File/image control | Leave blank unless an approved actual image asset (file ID or valid URL plus alt text) is supplied. A visual brief is not an image. |
| Thumbnail Image | File/image control | Same policy as Main Image. |
| Featured? | Toggle | Leave at the Webflow default unless the thread explicitly says to feature the post. |
| Color | Color input | Leave blank unless a valid color value is supplied. |
| Writer | Required text-like control | Require an explicit per-post value or a separately approved environment default. Never infer it from the Slack author. |
| Tag | Required dropdown-like control | Require an explicit thread value or separately approved environment default, then resolve it to the schema option ID. |
| Writer Profile Image | File/image control | Leave blank unless an approved image asset is supplied. |
| Category | Token/reference-like control | Leave blank unless the thread supplies a category and a unique matching collection item can be resolved to its ID. |
| Slide Show Popup | Image-upload control | Leave blank unless one or more approved image assets are supplied. |
| Created On (Inputted) | Date input | Leave blank unless the thread explicitly supplies a date and its business meaning is confirmed. It is not automatically the Webflow system creation time. |
| Locale / status | System UI | Create only in the primary English locale as a draft. |
| Sitemap indexing | System UI | Leave at the site's default; Slackflow does not modify indexing in version 1. |

### Required-field decision

The screenshots visibly mark **Name**, **Slug**, **Writer**, and **Tag** as required. A new item cannot be created without valid values for all four. Slackflow can derive Name and Slug safely; Writer and Tag need a business rule approved by the site owner. The current item happens to show `Datasaur` for both, but Slackflow will not treat that as a default until it is explicitly approved.

### Approved Tag taxonomy (content classification only)

The supplied dropdown shows these exact Tag labels:

| Exact label | Slackflow selection rule |
|---|---|
| `NLP Labeling` | Natural-language annotation, labeling workflows, or NLP datasets are the main topic. |
| `Labeling` | General data annotation or labeling is the main topic, without the NLP-specific focus. |
| `AI Industry` | AI models, infrastructure, market/industry analysis, adoption, or ecosystems are the main topic. |
| `Datasaur` | The article is primarily about Datasaur the company, product, or platform. |

The text model can only select one of these exact labels or stop for review. Every selected Tag includes a short rationale and Slack-message timestamps in the proposal. At write time Slackflow must resolve the selected display label to the **option ID** returned by `get_collection_details`; sending the label itself is not safe or sufficient for Webflow's API.

## Generated image asset flow

The checked-in prompt template is `prompts/image-generation.txt` and is preserved verbatim from the supplied instruction. At runtime Slackflow substitutes only `{blog title}` and `{blog content}`. It produces one generated Blog Image:

| Slackflow asset intent | Visible Webflow field | Policy |
|---|---|---|
| Blog Image | CMS target to be confirmed from schema | 1920×1080 delivered asset, produced from GPT Image 2's 1536×1024 landscape source; only after image preview approval, asset upload, and schema mapping. |

The exact supplied prompt still says 1920×1080, untouched. The documented `gpt-image-2` Images API sizes are `1024×1024`, `1024×1536`, `1536×1024`, and `auto`; Slackflow uses the landscape source option **1536×1024**. It then exports the delivered asset at **1920×1080** with a pure-black canvas and no crop, preserving the source and using the prompt's requested negative side space.

Webflow's `data_assets_tool` upload is two steps: (1) `create_asset` gets a presigned upload target, and (2) Slackflow uploads the generated binary bytes to that target. Only the resulting actual Webflow asset reference can be mapped to the Image fields. Text prompts/briefs are never passed as image field values.

## Write and verify sequence

1. Read the configured collection schema and compare its hash to the approved configuration.
2. Build the confirmation form and stop on every unmapped required or incompatible field.
3. Require an authorized Slack user to approve the exact form.
4. Call the fixed create-draft action for the configured collection only.
5. Read the created item back and verify it is a draft, not archived, and has no publication timestamp.
6. Reply with the CMS item ID/link and an audit record.

## What we need next

The best input is a read-only collection-schema result from Webflow MCP: collection name, ID, and all field definitions. Do not send tokens or credentials.

If MCP access is not ready, screenshots of the Webflow CMS collection's **Fields** page can help draft a provisional mapping, but they cannot safely replace the schema because they may omit field slugs, required flags, option IDs, reference targets, and validations.

## Official sources

- Webflow MCP CMS actions: https://developers.webflow.com/mcp/tools/data-tools
- Webflow MCP overview and permission model: https://developers.webflow.com/mcp/reference/overview
- Webflow CMS collection schema: https://developers.webflow.com/data/reference/cms/collections/get
- Webflow field types and values: https://developers.webflow.com/data/reference/field-types-item-values
- Webflow staged-item creation: https://developers.webflow.com/data/reference/cms/collection-items/staged-items/create-items
