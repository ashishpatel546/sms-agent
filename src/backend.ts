import { randomUUID } from 'node:crypto';

/** A non-2xx answer from sms-backend, with the message it gave. */
export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

export interface Quota {
  month: string;
  limit: number;
  used: number;
  remaining: number;
}

export interface HostUsage {
  kind: 'LLM' | 'STT' | 'TTS';
  model?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  audioSeconds?: number;
  characters?: number;
}

export interface ActionRequest {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: Record<string, unknown> | null;
}

export interface Executable {
  id: string;
  summary: string;
  status: string;
  request: ActionRequest;
}

/**
 * sms-backend client for the few calls this service makes itself (quota,
 * usage reports, running confirmed changes). Everything else goes through
 * the MCP tools.
 */
export class SmsBackend {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly slug: string,
    private readonly timeoutMs = 20_000,
  ) {}

  quota() {
    return this.request<Quota>('GET', '/agent/quota');
  }

  reportUsage(usage: HostUsage) {
    return this.request<{ credits: number; quota: Quota }>(
      'POST',
      '/agent/usage/report',
      { body: usage },
    );
  }

  /** PENDING → CONFIRMED (agent confirm mode). Returns the stored request. */
  confirmAction(id: string) {
    return this.request<Executable>('POST', `/agent/actions/${id}/confirm`, {
      tool: 'confirm_button',
    });
  }

  cancelAction(id: string) {
    return this.request<{ id: string; status: string }>(
      'POST',
      `/agent/actions/${id}/cancel`,
      { tool: 'cancel_button' },
    );
  }

  getAction(id: string) {
    return this.request<{ id: string; summary: string; status: string }>(
      'GET',
      `/agent/actions/${id}`,
    );
  }

  /**
   * Sends a confirmed change. sms-backend runs it only if method, path and
   * body are exactly what the user confirmed for this action, and only once.
   */
  execute(actionId: string, req: ActionRequest) {
    return this.request<unknown>(req.method, req.path, {
      body: req.body ?? undefined,
      actionId,
      tool: 'confirm_action',
    });
  }

  async request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; tool?: string; actionId?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'X-School-Slug': this.slug,
      'X-Agent-Call-Id': randomUUID(),
      Accept: 'application/json',
    };
    if (opts.tool) headers['X-Agent-Tool'] = opts.tool;
    if (opts.actionId) headers['X-Agent-Action-Id'] = opts.actionId;
    const hasBody = opts.body !== undefined && opts.body !== null;
    if (hasBody) headers['Content-Type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: hasBody ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason =
        (err as Error).name === 'TimeoutError' ? 'timed out' : 'could not be reached';
      throw new BackendError(503, `The school system ${reason}. Try again shortly.`);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const p = (data ?? {}) as { message?: string | string[]; code?: string };
      const message = Array.isArray(p.message)
        ? p.message.join('; ')
        : (p.message ?? `Request failed (${res.status}).`);
      throw new BackendError(res.status, message, p.code);
    }
    return data as T;
  }
}
