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
  /** Whose credits bind: the school's, or the person's own monthly limit. */
  limitedBy?: 'school' | 'user';
  /** Why no credits are left, when none are (names the person's own limit). */
  message?: string | null;
  /** sms-backend's AGENT_CONFIRM_REQUIRES_USER_TOKEN: only the app may confirm. */
  confirmRequiresUserToken?: boolean;
  /** Chat model chosen in the hub; null: use AGENT_MODEL. */
  model?: string | null;
  reasoningEffort?: 'none' | 'minimal' | null;
  /** Idle minutes after which the assistant session (conversation) is over. */
  sessionIdleMinutes?: number;
  /** Earlier exchanges the model sees with each message. */
  historyMaxTurns?: number;
  /** 'off' | 'device' | a speech-to-text model (hub setting). */
  voiceInput?: string;
  /** 'off' | 'device' | a text-to-speech model (hub setting). */
  voiceOutput?: string;
  ttsVoice?: string;
  /** Provider model for server speech (a device choice's fallback too); null = none. */
  voiceInputModel?: string | null;
  voiceOutputModel?: string | null;
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
    private readonly hostKey = '',
  ) {}

  quota() {
    return this.request<Quota>('GET', '/agent/quota');
  }

  /** Ends this token's assistant session (new chat); its tokens stop working. */
  endSession() {
    return this.request<{ ended: boolean }>('POST', '/agent/session/end');
  }

  /**
   * Reports model or voice usage for billing. Carries this service's host
   * key and one report id: a failed attempt is retried (twice, on a network
   * error or a 5xx) and sms-backend counts the id once, so a retry can never
   * charge twice.
   */
  async reportUsage(usage: HostUsage) {
    const body = { ...usage, reportId: randomUUID() };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.request<{ credits: number; quota: Quota }>(
          'POST',
          '/agent/usage/report',
          { body, hostKey: true },
        );
      } catch (err) {
        const status = (err as { status?: number }).status ?? 0;
        if (attempt >= 3 || (status > 0 && status < 500)) throw err;
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }
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
    opts: { body?: unknown; tool?: string; actionId?: string; hostKey?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      'X-School-Slug': this.slug,
      'X-Agent-Call-Id': randomUUID(),
      Accept: 'application/json',
    };
    if (opts.tool) headers['X-Agent-Tool'] = opts.tool;
    if (opts.actionId) headers['X-Agent-Action-Id'] = opts.actionId;
    if (opts.hostKey && this.hostKey) headers['X-Agent-Host-Key'] = this.hostKey;
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
