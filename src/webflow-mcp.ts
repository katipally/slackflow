import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import {
  Client,
  type OAuthClientInformationContext,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  StreamableHTTPClientTransport,
  UnauthorizedError
} from "@modelcontextprotocol/client";

import { WebflowConnectionStore } from "./webflow-connection-store.js";
import type { WebflowDraftContract } from "./webflow-draft.js";

const CONNECTION_SESSION = "connection";
const PENDING_PREFIX = "pending:";
const PENDING_TTL_MS = 10 * 60 * 1000;

type PendingMetadata = {
  expiresAt: number;
  slackContext?: WebflowConnectionContext;
};

export type WebflowConnectionContext = {
  channel: string;
  threadTs: string;
  messageTs?: string;
};

type ConnectionMetadata = {
  connectedAt: number;
  serverName?: string;
  serverVersion?: string;
};

export type WebflowToolData = {
  data: unknown;
  text: string;
};

export type SavedWebflowSchema = {
  collectionId: string;
  contract?: WebflowDraftContract;
  readAt: number;
  schema: unknown;
  siteId: string;
};

export type WebflowAsset = { id: string; url?: string };
export type WebflowCreatedItem = { id: string; editorUrl?: string; isDraft?: boolean };

/**
 * The hosted Webflow data tools require both an overall context and a label for
 * each requested action. Keeping that contract in one small helper prevents a
 * later read from silently omitting either required field.
 */
export function createWebflowDataToolRequest(
  context: string,
  label: string,
  action: Record<string, unknown>
): Record<string, unknown> {
  return { actions: [{ label, ...action }], context };
}

/**
 * Webflow MCP creates CMS items in bulk, even when Slackflow intentionally
 * creates only one approved draft. The tool therefore requires fieldData to
 * be an array containing the one item, rather than a single field-data object.
 */
export function createWebflowCollectionDraftAction(
  collectionId: string,
  fieldData: Record<string, unknown>
): Record<string, unknown> {
  return { create_collection_items: { collection_id: collectionId, request: { fieldData: [fieldData] } } };
}

type PendingConnection = {
  client: Client;
  provider: WebflowOAuthProvider;
  transport: StreamableHTTPClientTransport;
};

export type WebflowMcpConfig = {
  mcpUrl: string;
  publicBaseUrl: string;
  statePath: string;
  tokenEncryptionKey: string;
};

export type WebflowConnectionStatus =
  | { state: "configuration_missing"; message: string }
  | { state: "not_connected" }
  | { state: "connected"; connectedAt: number; serverName?: string; serverVersion?: string };

function randomValue(): string {
  return randomBytes(32).toString("base64url");
}

function sameValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function validateConfig(config: WebflowMcpConfig): string | undefined {
  try {
    const mcpUrl = new URL(config.mcpUrl);
    const publicBaseUrl = new URL(config.publicBaseUrl);

    if (mcpUrl.protocol !== "https:" || publicBaseUrl.protocol !== "https:") {
      return "WEBFLOW_MCP_URL and PUBLIC_BASE_URL must use HTTPS.";
    }
  } catch {
    return "WEBFLOW_MCP_URL or PUBLIC_BASE_URL is not a valid URL.";
  }

  if (!config.tokenEncryptionKey) {
    return "WEBFLOW_TOKEN_ENCRYPTION_KEY is missing.";
  }

  if (Buffer.from(config.tokenEncryptionKey, "base64").length !== 32) {
    return "WEBFLOW_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key.";
  }

  return undefined;
}

class WebflowOAuthProvider implements OAuthClientProvider {
  readonly clientMetadata: OAuthClientMetadata;

  constructor(
    private readonly store: WebflowConnectionStore,
    private readonly sessionId: string,
    readonly redirectUrl: string
  ) {
    this.clientMetadata = {
      application_type: "web",
      client_name: "Slackflow",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [redirectUrl],
      response_types: ["code"],
      token_endpoint_auth_method: "none"
    };
  }

  state(): string {
    const savedState = this.store.get<string>(this.sessionId, "oauth_state");

    if (savedState) {
      return savedState;
    }

    const state = randomValue();
    this.store.set(this.sessionId, "oauth_state", state);
    return state;
  }

  clientInformation(_context?: OAuthClientInformationContext): StoredOAuthClientInformation | undefined {
    return this.store.get<StoredOAuthClientInformation>(this.sessionId, "client_information");
  }

  saveClientInformation(clientInformation: StoredOAuthClientInformation, _context?: OAuthClientInformationContext): void {
    this.store.set(this.sessionId, "client_information", clientInformation);
  }

  tokens(_context?: OAuthClientInformationContext): StoredOAuthTokens | undefined {
    return this.store.get<StoredOAuthTokens>(this.sessionId, "tokens");
  }

  saveTokens(tokens: StoredOAuthTokens, _context?: OAuthClientInformationContext): void {
    this.store.set(this.sessionId, "tokens", tokens);
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    this.store.set(this.sessionId, "authorization_url", authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.store.set(this.sessionId, "code_verifier", codeVerifier);
  }

  codeVerifier(): string {
    const codeVerifier = this.store.get<string>(this.sessionId, "code_verifier");

    if (!codeVerifier) {
      throw new Error("Webflow OAuth session has expired. Start @slackflow connect again.");
    }

    return codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.store.set(this.sessionId, "discovery_state", state);
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.store.get<OAuthDiscoveryState>(this.sessionId, "discovery_state");
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    if (scope === "all" || scope === "client") this.store.remove(this.sessionId, "client_information");
    if (scope === "all" || scope === "tokens") this.store.remove(this.sessionId, "tokens");
    if (scope === "all" || scope === "verifier") this.store.remove(this.sessionId, "code_verifier");
    if (scope === "all" || scope === "discovery") this.store.remove(this.sessionId, "discovery_state");
  }
}

export class WebflowMcpConnection {
  readonly configurationError: string | undefined;
  private readonly pendingConnections = new Map<string, PendingConnection>();
  private readonly store?: WebflowConnectionStore;

  constructor(private readonly config: WebflowMcpConfig) {
    this.configurationError = validateConfig(config);
    this.store = this.configurationError ? undefined : new WebflowConnectionStore(config.statePath, config.tokenEncryptionKey);
  }

  createConnectionLink(slackContext?: WebflowConnectionContext): { link: string; requestId: string } | { error: string } {
    if (!this.store || this.configurationError) {
      return { error: this.configurationError ?? "Webflow MCP is not configured." };
    }

    const requestId = randomValue();
    this.store.set(this.pendingSession(requestId), "metadata", { expiresAt: Date.now() + PENDING_TTL_MS, slackContext } satisfies PendingMetadata);

    const link = new URL("/webflow/connect", this.config.publicBaseUrl);
    link.searchParams.set("request", requestId);
    return { link: link.toString(), requestId };
  }

  recordConnectionMessage(requestId: string, messageTs: string): void {
    const store = this.requireStore();
    const metadata = this.requirePendingRequest(requestId);

    if (!metadata.slackContext) return;
    store.set(this.pendingSession(requestId), "metadata", {
      ...metadata,
      slackContext: { ...metadata.slackContext, messageTs }
    } satisfies PendingMetadata);
  }

  async startAuthorization(requestId: string): Promise<string> {
    const store = this.requireStore();
    this.requirePendingRequest(requestId);

    const sessionId = this.pendingSession(requestId);
    const callbackUrl = new URL("/webflow/oauth/callback", this.config.publicBaseUrl);
    callbackUrl.searchParams.set("request", requestId);

    const provider = new WebflowOAuthProvider(store, sessionId, callbackUrl.toString());
    const transport = this.createTransport(provider);
    const client = this.createClient();

    try {
      await client.connect(transport);
      await client.close();
      throw new Error("Webflow did not request OAuth authorization.");
    } catch (error) {
      if (!UnauthorizedError.isInstance(error)) {
        await client.close().catch(() => undefined);
        throw error;
      }
    }

    const authorizationUrl = store.get<string>(sessionId, "authorization_url");

    if (!authorizationUrl) {
      await client.close().catch(() => undefined);
      throw new Error("Webflow did not provide an authorization URL.");
    }

    this.pendingConnections.set(requestId, { client, provider, transport });
    return authorizationUrl;
  }

  async completeAuthorization(requestId: string, callbackParams: URLSearchParams): Promise<WebflowConnectionContext | undefined> {
    const store = this.requireStore();
    const pendingMetadata = this.requirePendingRequest(requestId);

    if (!callbackParams.get("code") || callbackParams.get("error")) {
      throw new Error("Webflow authorization was not completed.");
    }

    const expectedState = store.get<string>(this.pendingSession(requestId), "oauth_state");
    const returnedState = callbackParams.get("state");

    if (!expectedState || !returnedState || !sameValue(expectedState, returnedState)) {
      throw new Error("Webflow authorization state could not be verified.");
    }

    const pending = this.pendingConnections.get(requestId);

    if (!pending) {
      throw new Error("Webflow authorization session expired. Start @slackflow connect again.");
    }

    try {
      await pending.transport.finishAuth(callbackParams);
      const authenticatedTransport = this.createTransport(pending.provider);
      await pending.client.connect(authenticatedTransport);

      for (const key of ["client_information", "tokens", "discovery_state"] as const) {
        const value = store.get<unknown>(this.pendingSession(requestId), key);
        if (value !== undefined) store.set(CONNECTION_SESSION, key, value);
      }

      const server = pending.client.getServerVersion();
      store.set(CONNECTION_SESSION, "metadata", {
        connectedAt: Date.now(),
        serverName: server?.name,
        serverVersion: server?.version
      } satisfies ConnectionMetadata);

      await authenticatedTransport.terminateSession().catch(() => undefined);
      await pending.client.close();
      return pendingMetadata.slackContext;
    } finally {
      this.pendingConnections.delete(requestId);
      store.removeSession(this.pendingSession(requestId));
    }
  }

  status(): WebflowConnectionStatus {
    if (!this.store || this.configurationError) {
      return { state: "configuration_missing", message: this.configurationError ?? "Webflow MCP is not configured." };
    }

    const metadata = this.store.get<ConnectionMetadata>(CONNECTION_SESSION, "metadata");
    const tokens = this.store.get<StoredOAuthTokens>(CONNECTION_SESSION, "tokens");

    if (!metadata || !tokens) {
      return { state: "not_connected" };
    }

    return { state: "connected", ...metadata };
  }

  disconnect(): WebflowConnectionStatus {
    if (!this.store || this.configurationError) {
      return { state: "configuration_missing", message: this.configurationError ?? "Webflow MCP is not configured." };
    }

    this.store.removeSession(CONNECTION_SESSION);
    return { state: "not_connected" };
  }

  /** These reads are intentionally the only CMS operations enabled at this stage. */
  async listSites(): Promise<WebflowToolData> {
    return this.callTool(
      "data_sites_tool",
      createWebflowDataToolRequest(
        "Slackflow lists accessible Webflow sites so the user can choose the target site for CMS draft setup.",
        "List accessible Webflow sites",
        { list_sites: {} }
      )
    );
  }

  async listCollections(siteId: string): Promise<WebflowToolData> {
    return this.callTool(
      "data_cms_tool",
      createWebflowDataToolRequest(
        "Slackflow lists CMS collections in the selected site so the user can choose the target collection safely.",
        "List CMS collections",
        { get_collection_list: { siteId } }
      )
    );
  }

  async getCollectionDetails(collectionId: string): Promise<WebflowToolData> {
    return this.callTool(
      "data_cms_tool",
      createWebflowDataToolRequest(
        "Slackflow reads the selected CMS collection fields to validate the draft mapping before any content is created.",
        "Read selected CMS collection fields",
        { get_collection_details: { collection_id: collectionId } }
      )
    );
  }

  saveSchema(siteId: string, collectionId: string, schema: unknown, contract?: WebflowDraftContract): void {
    const store = this.requireConnectedStore();
    store.set(CONNECTION_SESSION, "cms_schema", schema);
    store.set(CONNECTION_SESSION, "cms_schema_metadata", { collectionId, readAt: Date.now(), siteId });
    if (contract) store.set(CONNECTION_SESSION, "cms_draft_contract", contract);
    else store.remove(CONNECTION_SESSION, "cms_draft_contract");
  }

  getSavedSchema(): SavedWebflowSchema | undefined {
    if (!this.store || this.configurationError || this.status().state !== "connected") return undefined;
    const metadata = this.store.get<{ collectionId?: string; readAt?: number; siteId?: string }>(CONNECTION_SESSION, "cms_schema_metadata");
    const schema = this.store.get<unknown>(CONNECTION_SESSION, "cms_schema");
    if (!metadata?.collectionId || !metadata.readAt || !metadata.siteId || schema === undefined) return undefined;
    const contract = this.store.get<WebflowDraftContract>(CONNECTION_SESSION, "cms_draft_contract");
    return { collectionId: metadata.collectionId, contract, readAt: metadata.readAt, schema, siteId: metadata.siteId };
  }

  schemaStatus(): { state: "not_read" } | { state: "read"; collectionId: string; readAt: number; siteId: string } {
    if (!this.store || this.configurationError) return { state: "not_read" };

    const metadata = this.store.get<{ collectionId?: string; readAt?: number; siteId?: string }>(CONNECTION_SESSION, "cms_schema_metadata");
    if (!metadata?.collectionId || !metadata.readAt || !metadata.siteId) return { state: "not_read" };
    return { state: "read", collectionId: metadata.collectionId, readAt: metadata.readAt, siteId: metadata.siteId };
  }

  async uploadImageAsset(input: {
    file: Buffer;
    filename: string;
    mimeType: string;
    siteId: string;
  }): Promise<WebflowAsset> {
    if (input.file.byteLength > 4 * 1024 * 1024) {
      throw new Error("The reviewed Blog Image is larger than Webflow's 4 MB asset-upload limit.");
    }

    const fileHash = createHash("md5").update(input.file).digest("hex");
    const result = await this.callTool(
      "data_assets_tool",
      createWebflowDataToolRequest(
        "Slackflow uploads the single user-reviewed blog image for an explicitly approved unpublished CMS draft.",
        "Create CMS draft image asset",
        { create_asset: { file_hash: fileHash, file_name: input.filename, site_id: input.siteId } }
      )
    );
    const upload = findAssetUpload(result.data);
    if (!upload) throw new Error("Webflow did not return an upload target for the approved image asset.");

    const response = await uploadWebflowAsset(upload, input);
    if (!response.ok) {
      const uploadMethod = "Policy" in upload.uploadDetails || "policy" in upload.uploadDetails ? "POST" : "PUT";
      const detailKeys = Object.keys(upload.uploadDetails).sort().join(", ");
      const scopeHint = response.status === 403 ? " Check the Webflow OAuth connection includes assets:write, then reconnect and retry." : "";
      throw new Error(`${await webflowUploadError(response)}${scopeHint} Upload target: ${new URL(upload.uploadUrl).host}, method ${uploadMethod}, signed fields [${detailKeys}].`);
    }

    // Webflow normally returns the final hosted URL with create_asset. Only
    // perform a read-back when it omitted that URL; the CMS image field must
    // never receive the presigned upload URL.
    if (upload.url) return { id: upload.id, url: upload.url };
    const savedAsset = await this.callTool(
      "data_assets_tool",
      createWebflowDataToolRequest(
        "Slackflow confirms the uploaded image asset before mapping it into the new CMS draft.",
        "Confirm uploaded CMS draft image asset",
        { get_asset: { asset_id: upload.id } }
      )
    );
    return { id: upload.id, url: findAssetUrl(savedAsset.data) };
  }

  async createCollectionDraft(input: { collectionId: string; fieldData: Record<string, unknown> }): Promise<WebflowCreatedItem> {
    const result = await this.callTool(
      "data_cms_tool",
      createWebflowDataToolRequest(
        "Slackflow creates one explicitly approved unpublished CMS draft using the previously validated field mapping.",
        "Create unpublished CMS draft",
        createWebflowCollectionDraftAction(input.collectionId, input.fieldData)
      )
    );
    const item = findCreatedItem(result.data);
    if (!item) throw new Error("Webflow did not return the created CMS draft item.");
    return item;
  }

  private createClient(): Client {
    return new Client({ name: "slackflow", version: "0.1.0" });
  }

  private createTransport(provider: WebflowOAuthProvider): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(this.config.mcpUrl), { authProvider: provider });
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<WebflowToolData> {
    const store = this.requireConnectedStore();
    const callbackUrl = new URL("/webflow/oauth/callback", this.config.publicBaseUrl).toString();
    const provider = new WebflowOAuthProvider(store, CONNECTION_SESSION, callbackUrl);
    const transport = this.createTransport(provider);
    const client = this.createClient();

    try {
      await client.connect(transport);
      await this.ensureTool(client, name);
      const result = await client.callTool({ arguments: args, name });
      const text = result.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n");

      if (result.isError) {
        throw new Error(text || "Webflow MCP could not complete the read-only request.");
      }

      return { data: result.structuredContent ?? parseJson(text), text };
    } catch (error) {
      if (UnauthorizedError.isInstance(error)) {
        throw new Error("Webflow OAuth is no longer valid. Run @slackflow connect again.");
      }
      throw error;
    } finally {
      await transport.terminateSession().catch(() => undefined);
      await client.close().catch(() => undefined);
    }
  }

  private async ensureTool(client: Client, requiredTool: string): Promise<void> {
    const available = await client.listTools();
    if (available.tools.some((tool) => tool.name === requiredTool)) return;

    if (!available.tools.some((tool) => tool.name === "get_more_tools")) {
      throw new Error(`Webflow MCP did not make the required ${requiredTool} tool available.`);
    }

    const result = await client.callTool({
      name: "get_more_tools",
      arguments: {
        brief: `Slackflow needs ${requiredTool} for its explicit Webflow CMS workflow.`,
        category: "data",
        context: "Slackflow lists sites and reads collection schemas. After a user confirms a reviewed proposal, it may upload one image asset and create one unpublished CMS draft. It never publishes or deletes Webflow content."
      }
    });

    if (result.isError) {
      throw new Error("Webflow MCP could not load its required read-only data tool.");
    }

    const refreshed = await client.listTools();
    if (!refreshed.tools.some((tool) => tool.name === requiredTool)) {
      throw new Error(`Webflow MCP did not provide the required ${requiredTool} tool.`);
    }
  }

  private pendingSession(requestId: string): string {
    return `${PENDING_PREFIX}${requestId}`;
  }

  private requirePendingRequest(requestId: string): PendingMetadata {
    const metadata = this.requireStore().get<PendingMetadata>(this.pendingSession(requestId), "metadata");

    if (!metadata || metadata.expiresAt < Date.now()) {
      this.requireStore().removeSession(this.pendingSession(requestId));
      throw new Error("Webflow connection link expired. Start @slackflow connect again.");
    }

    return metadata;
  }

  private requireStore(): WebflowConnectionStore {
    if (!this.store || this.configurationError) {
      throw new Error(this.configurationError ?? "Webflow MCP is not configured.");
    }

    return this.store;
  }

  private requireConnectedStore(): WebflowConnectionStore {
    const status = this.status();
    if (status.state !== "connected") {
      throw new Error(status.state === "configuration_missing" ? status.message : "Webflow is not connected. Run @slackflow connect first.");
    }

    return this.requireStore();
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

type AssetUploadTarget = { id: string; uploadUrl: string; uploadDetails: Record<string, unknown>; url?: string };

/**
 * The MCP JSON schema may expose S3 POST fields as camelCase, while the
 * signed policy requires the exact S3 wire names. Preserve already-correct
 * names and normalize only the known fields.
 */
export function webflowS3FieldName(name: string): string {
  const normalized = name.replaceAll("-", "").replaceAll("_", "").toLowerCase();
  const names: Record<string, string> = {
    cachecontrol: "Cache-Control",
    contenttype: "content-type",
    policy: "Policy",
    successactionstatus: "success_action_status",
    xamzalgorithm: "X-Amz-Algorithm",
    xamzcredential: "X-Amz-Credential",
    xamzdate: "X-Amz-Date",
    xamzsecuritytoken: "X-Amz-Security-Token",
    xamzsignature: "X-Amz-Signature"
  };
  return names[normalized] ?? name;
}

async function uploadWebflowAsset(target: AssetUploadTarget, input: { file: Buffer; filename: string; mimeType: string }): Promise<Response> {
  const entries = Object.entries(target.uploadDetails);
  if (entries.some(([, value]) => typeof value !== "string" && typeof value !== "number")) {
    throw new Error("Webflow returned an invalid image upload field.");
  }

  const uploadBytes = new Uint8Array(input.file.byteLength);
  uploadBytes.set(input.file);
  const signedContentType = entries.find(([key, value]) => webflowS3FieldName(key).toLowerCase() === "content-type" && typeof value === "string")?.[1];
  const contentType = typeof signedContentType === "string" ? signedContentType : input.mimeType;

  // Webflow returns an S3 POST policy when it includes Policy. Preserve every
  // signed value, use its exact S3 wire field name, and append file last.
  if ("Policy" in target.uploadDetails || "policy" in target.uploadDetails) {
    const form = new FormData();
    for (const [key, value] of entries) form.append(webflowS3FieldName(key), String(value));
    form.append("file", new Blob([uploadBytes], { type: contentType }), input.filename);
    return fetch(target.uploadUrl, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  }

  // This supports a future Webflow upload target that uses signed PUT headers.
  const headers = new Headers(entries.map(([key, value]) => [key, String(value)]));
  if (!headers.has("content-type")) headers.set("content-type", contentType);
  return fetch(target.uploadUrl, { method: "PUT", headers, body: uploadBytes, signal: AbortSignal.timeout(120_000) });
}

async function webflowUploadError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  const code = body.match(/<Code>([^<]+)<\/Code>/i)?.[1];
  const message = body.match(/<Message>([^<]+)<\/Message>/i)?.[1];
  const requestId = body.match(/<RequestId>([^<]+)<\/RequestId>/i)?.[1];
  const suffix = [code, message && message !== code ? message : undefined, requestId ? `request ${requestId}` : undefined].filter(Boolean).join(", ");
  return `Webflow image upload failed with status ${response.status}${suffix ? ` (${suffix})` : ""}.`;
}

function findAssetUrl(value: unknown): string | undefined {
  const seen = new Set<unknown>();
  const visit = (item: unknown): string | undefined => {
    if (!item || typeof item !== "object" || seen.has(item)) return undefined;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    }
    const record = item as Record<string, unknown>;
    for (const key of ["hostedUrl", "assetUrl", "url"]) {
      if (typeof record[key] === "string" && record[key].trim()) return record[key];
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value);
}

function findAssetUpload(value: unknown): AssetUploadTarget | undefined {
  const seen = new Set<unknown>();
  const visit = (item: unknown): AssetUploadTarget | undefined => {
    if (!item || typeof item !== "object" || seen.has(item)) return undefined;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    }
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : undefined;
    const uploadUrl = typeof record.uploadUrl === "string" ? record.uploadUrl : undefined;
    const uploadDetails = isRecord(record.uploadDetails) ? record.uploadDetails : undefined;
    if (id && uploadUrl && uploadDetails) {
      const url = typeof record.hostedUrl === "string" ? record.hostedUrl : typeof record.assetUrl === "string" ? record.assetUrl : undefined;
      return { id, uploadUrl, uploadDetails, url };
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value);
}

function findCreatedItem(value: unknown): WebflowCreatedItem | undefined {
  const seen = new Set<unknown>();
  const visit = (item: unknown): WebflowCreatedItem | undefined => {
    if (!item || typeof item !== "object" || seen.has(item)) return undefined;
    seen.add(item);
    if (Array.isArray(item)) {
      for (const child of item) {
        const found = visit(child);
        if (found) return found;
      }
      return undefined;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.id === "string" && ("fieldData" in record || "isDraft" in record || "lastUpdated" in record)) {
      const editorUrl = typeof record.editorUrl === "string" ? record.editorUrl : typeof record.webflowUrl === "string" ? record.webflowUrl : undefined;
      return { id: record.id, editorUrl, isDraft: typeof record.isDraft === "boolean" ? record.isDraft : undefined };
    }
    for (const child of Object.values(record)) {
      const found = visit(child);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
