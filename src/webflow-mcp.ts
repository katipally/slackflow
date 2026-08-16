import { randomBytes, timingSafeEqual } from "node:crypto";

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

  saveSchema(siteId: string, collectionId: string, schema: unknown): void {
    const store = this.requireConnectedStore();
    store.set(CONNECTION_SESSION, "cms_schema", schema);
    store.set(CONNECTION_SESSION, "cms_schema_metadata", { collectionId, readAt: Date.now(), siteId });
  }

  schemaStatus(): { state: "not_read" } | { state: "read"; collectionId: string; readAt: number; siteId: string } {
    if (!this.store || this.configurationError) return { state: "not_read" };

    const metadata = this.store.get<{ collectionId?: string; readAt?: number; siteId?: string }>(CONNECTION_SESSION, "cms_schema_metadata");
    if (!metadata?.collectionId || !metadata.readAt || !metadata.siteId) return { state: "not_read" };
    return { state: "read", collectionId: metadata.collectionId, readAt: metadata.readAt, siteId: metadata.siteId };
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
        brief: `Read-only Slackflow CMS discovery needs ${requiredTool}.`,
        category: "data",
        context: "Slackflow only lists sites and reads CMS collection schemas. It does not create, edit, publish, or delete Webflow content."
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
