import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AgentClaims } from './claims.js';

export interface ToolSpec {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DraftInfo {
  action_ids: string[];
  summary: string;
  expires_at: string | null;
}

export interface ToolOutcome {
  text: string;
  isError: boolean;
  draft?: DraftInfo;
}

/** What the agent loop needs from the tool server — faked in tests. */
export interface ToolSource {
  catalog(): Promise<{ tools: ToolSpec[]; instructions: string }>;
  call(name: string, args: Record<string, unknown>): Promise<ToolOutcome>;
  close(): Promise<void>;
}

/** sms-mcp refused the session (bad/expired token, no credits, …). */
export class ToolServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface Catalog {
  tools: ToolSpec[];
  instructions: string;
  at: number;
}

/**
 * Tool lists per agent session. The list is fixed for a session (it depends
 * only on the user's role and the school's modules), and keeping it byte-for-
 * byte stable is what lets the model provider cache the prompt prefix.
 */
export class CatalogCache {
  private readonly entries = new Map<string, Catalog>();

  constructor(private readonly ttlMs = 10 * 60_000) {}

  get(key: string): Catalog | undefined {
    const e = this.entries.get(key);
    if (e && Date.now() - e.at < this.ttlMs) return e;
    this.entries.delete(key);
    return undefined;
  }

  set(key: string, tools: ToolSpec[], instructions: string) {
    if (this.entries.size > 5000) this.entries.clear();
    this.entries.set(key, { tools, instructions, at: Date.now() });
  }
}

function errorStatus(err: unknown): number {
  if (err instanceof StreamableHTTPError && err.code && err.code > 0) {
    return err.code;
  }
  return 502;
}

/** "Error POSTing to endpoint: {json-rpc error}" → the server's message. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const json = raw.indexOf('{');
  if (json >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(json)) as {
        error?: { message?: string };
      };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      // fall through
    }
  }
  return 'The school tools are unavailable right now. Try again shortly.';
}

/**
 * MCP client for one request, bound to the user's agent token. Connects
 * lazily: a turn whose tool list is cached and that calls no tool makes no
 * request to sms-mcp at all.
 */
export class McpTools implements ToolSource {
  private client: Client | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly claims: AgentClaims,
    private readonly cache: CatalogCache,
    private readonly key = '',
  ) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'sms-agent', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(this.key ? { 'X-MCP-Key': this.key } : {}),
        },
      },
    });
    try {
      await client.connect(transport);
    } catch (err) {
      throw new ToolServerError(errorStatus(err), errorMessage(err));
    }
    this.client = client;
    return client;
  }

  async catalog() {
    const key = this.claims.agentSessionId ?? this.token;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const client = await this.connect();
    let tools: ToolSpec[];
    try {
      const res = await client.listTools();
      tools = res.tools.map((t) => ({
        name: t.name,
        title: t.title ?? t.annotations?.title,
        description: t.description ?? '',
        inputSchema: t.inputSchema as Record<string, unknown>,
      }));
    } catch (err) {
      throw new ToolServerError(errorStatus(err), errorMessage(err));
    }
    const instructions = client.getInstructions() ?? '';
    this.cache.set(key, tools, instructions);
    return { tools, instructions };
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    try {
      const client = await this.connect();
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as { type: string; text?: string }[])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('\n');
      const draft = (res.structuredContent as { draft?: DraftInfo } | undefined)
        ?.draft;
      return { text, isError: res.isError === true, draft };
    } catch (err) {
      const status = err instanceof ToolServerError ? err.status : errorStatus(err);
      const message = err instanceof ToolServerError ? err.message : errorMessage(err);
      if (status === 401 || status === 402) throw new ToolServerError(status, message);
      return { text: message, isError: true };
    }
  }

  async close() {
    await this.client?.close().catch(() => undefined);
    this.client = null;
  }
}
