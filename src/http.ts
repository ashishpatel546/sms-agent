import { createHash } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { Agent, toFailure, type AgentEvent, type ErrorCode } from './agent.js';
import { SmsBackend, type Quota } from './backend.js';
import { bearer, ownerKey, requireAgentClaims, TokenError, type AgentClaims } from './claims.js';
import type { Config } from './config.js';
import { ConversationStore, type Conversation } from './conversations.js';
import type { ChatModel } from './llm.js';
import { CatalogCache, McpTools, type ToolSource } from './mcp.js';
import { RateLimiter } from './ratelimit.js';
import { Voice, VoiceUnavailable, voiceMode } from './voice.js';

export const SERVICE = { name: 'sms-agent', version: '0.1.0' };

interface Session {
  token: string;
  claims: AgentClaims;
  owner: string;
  backend: SmsBackend;
}

export interface AppDeps {
  config: Config;
  model: ChatModel;
  voice?: Voice;
  /** Tool source for a session — sms-mcp over HTTP unless a test swaps it. */
  tools?: (token: string, claims: AgentClaims) => ToolSource;
}

const STATUS: Record<ErrorCode, number> = {
  SESSION_EXPIRED: 401,
  SESSION_ENDED: 401,
  CREDITS_EXHAUSTED: 402,
  FORBIDDEN: 403,
  MODEL_UNAVAILABLE: 503,
  TOOLS_UNAVAILABLE: 502,
  INTERNAL: 500,
};

function fail(res: Response, status: number, code: string, message: string) {
  res.status(status).json({ code, message });
}

function failWith(res: Response, err: unknown) {
  const f = toFailure(err);
  fail(res, STATUS[f.code], f.code, f.message);
}

const uuid = z.string().uuid();

const ChatBody = z.object({
  conversationId: uuid.optional(),
  message: z.string().trim().min(1),
  mode: z.enum(['text', 'voice']).default('text'),
});

const ActionsBody = z.object({
  conversationId: uuid,
  actionIds: z.array(uuid).min(1).max(8),
});

const ExecuteBody = z.object({
  conversationId: uuid,
  actions: z
    .array(
      z.object({
        id: uuid,
        request: z.object({
          method: z.enum(['POST', 'PUT', 'PATCH', 'DELETE']),
          path: z.string().regex(/^\/[A-Za-z0-9/_:.-]*$/).max(255),
          body: z.record(z.string(), z.unknown()).nullable().optional(),
        }),
      }),
    )
    .min(1)
    .max(8),
});

const SpeakBody = z.object({ text: z.string().trim().min(1).max(4000) });

/** Markdown and tables read badly aloud; speak the gist only. */
export function speakable(text: string, maxChars: number): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[*_#`>|]+/g, ' ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\[(.*?)\]\((.*?)\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= maxChars) return plain;
  const cut = plain.slice(0, maxChars);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return stop > maxChars / 3 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`;
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const agent = new Agent(config, deps.model);
  const voice = deps.voice ?? new Voice(config);
  const conversations = new ConversationStore(
    // A little past the backend's idle limit: sms-backend decides when a
    // session is over; this only frees memory afterwards.
    () => config.conversationTtlMs + 5 * 60_000,
    config.maxConversationsPerUser,
  );
  const catalogs = new CatalogCache();
  const toolsFor =
    deps.tools ??
    ((token: string, claims: AgentClaims) =>
      new McpTools(config.mcpUrl, token, claims, catalogs, config.mcpKey));
  const limiter = new RateLimiter(config.rateLimit, config.rateWindowMs);

  /**
   * Tokens sms-backend has accepted, by hash, until they expire. The token is
   * only decoded here, so nothing — rate-limit counters, conversations — is
   * touched for it until the backend has verified it once.
   */
  const verified = new Map<string, number>();
  const isVerified = (key: string) => (verified.get(key) ?? 0) > Date.now();
  const markVerified = (key: string, claims: AgentClaims) => {
    if (verified.size > 20_000) {
      const now = Date.now();
      for (const [k, exp] of verified) if (exp <= now) verified.delete(k);
      if (verified.size > 20_000) verified.clear();
    }
    verified.set(key, claims.exp ? claims.exp * 1000 : Date.now() + 5 * 60_000);
  };

  /**
   * sms-backend decides who confirms and how long a conversation may idle;
   * AGENT_CONFIRM_MODE and the built-in 30 minutes are only fallbacks.
   */
  const syncFromBackend = (q: Quota) => {
    if (typeof q.confirmRequiresUserToken === 'boolean') {
      config.confirmMode = q.confirmRequiresUserToken ? 'user' : 'agent';
    }
    if (typeof q.sessionIdleMinutes === 'number' && q.sessionIdleMinutes > 0) {
      config.conversationTtlMs = q.sessionIdleMinutes * 60_000;
    }
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  // CORS: the portal calls this service straight from the browser.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && config.corsOriginRegex.test(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, X-Audio-Duration-Ms',
      );
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', ...SERVICE });
  });

  const v1 = express.Router();

  v1.use(async (req: Request, res: Response, next: NextFunction) => {
    const token = bearer(req.headers.authorization);
    let claims: AgentClaims;
    try {
      claims = requireAgentClaims(token);
    } catch (err) {
      const message = err instanceof TokenError ? err.message : 'Unauthorized.';
      res.setHeader('WWW-Authenticate', 'Bearer');
      return fail(res, 401, 'SESSION_EXPIRED', message);
    }
    const session: Session = {
      token,
      claims,
      owner: ownerKey(claims),
      backend: new SmsBackend(config.smsApiUrl, token, claims.slug, config.requestTimeoutMs),
    };
    const key = createHash('sha256').update(token).digest('hex');
    if (!isVerified(key)) {
      try {
        const quota = await session.backend.quota();
        syncFromBackend(quota);
        markVerified(key, claims);
        res.locals.quota = quota;
      } catch (err) {
        if ((err as { status?: number }).status === 401) res.setHeader('WWW-Authenticate', 'Bearer');
        return failWith(res, err);
      }
    }
    res.locals.session = session;
    next();
  });

  const sessionOf = (res: Response) => res.locals.session as Session;

  const limited = (res: Response, owner: string) => {
    const wait = limiter.take(owner);
    if (!wait) return false;
    res.setHeader('Retry-After', String(wait));
    fail(res, 429, 'RATE_LIMITED', `Too many requests. Try again in ${wait} seconds.`);
    return true;
  };

  // Also the app's first call: it checks the token and the school's
  // assistant access with sms-backend, and returns the credits left.
  v1.get('/capabilities', async (_req, res) => {
    let quota = res.locals.quota as Quota | undefined;
    try {
      quota ??= await sessionOf(res).backend.quota();
      syncFromBackend(quota);
    } catch (err) {
      return failWith(res, err);
    }
    const input = voiceMode(quota.voiceInput ?? config.voiceInput);
    const output = voiceMode(quota.voiceOutput ?? config.voiceOutput);
    res.json({
      model: quota.model || config.model,
      conversationId: sessionOf(res).claims.agentSessionId,
      idleMinutes: Math.round(config.conversationTtlMs / 60_000),
      credits: { remaining: quota.remaining, limit: quota.limit, month: quota.month },
      confirmMode: config.confirmMode,
      // input/output: what the school chose in the hub. transcribe/speak:
      // whether server speech works right now (the app falls back to the
      // device's own speech when it does not).
      voice: {
        input,
        output,
        transcribe: input === 'server' && voice.available(quota.voiceInput),
        speak: output === 'server' && voice.available(quota.voiceOutput),
      },
      limits: {
        maxMessageChars: config.maxMessageChars,
        maxAudioSeconds: config.maxAudioSeconds,
      },
    });
  });

  v1.post('/chat', express.json({ limit: '32kb' }), async (req, res) => {
    const s = sessionOf(res);
    const parsed = ChatBody.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, 'BAD_REQUEST', 'A message is required.');
    }
    const { message, mode } = parsed.data;
    if (message.length > config.maxMessageChars) {
      return fail(
        res,
        413,
        'MESSAGE_TOO_LONG',
        `Keep messages under ${config.maxMessageChars} characters.`,
      );
    }
    if (limited(res, s.owner)) return;
    // One conversation per assistant session; conversationId in the body is
    // accepted for older apps but the session decides.
    const sessionId = s.claims.agentSessionId;
    const conv =
      conversations.get(s.owner, sessionId) ?? conversations.create(s.owner, sessionId);
    if (conv.busy) {
      return fail(res, 409, 'BUSY', 'Still answering your previous message.');
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) abort.abort();
    });
    const emit = (e: AgentEvent) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': keep-alive\n\n');
    }, 15_000);

    const tools = toolsFor(s.token, s.claims);
    conv.busy = true;
    try {
      emit({ type: 'start', conversationId: conv.id });
      await agent.runTurn({
        conv,
        claims: s.claims,
        message,
        mode,
        tools,
        backend: s.backend,
        emit,
        signal: abort.signal,
      });
    } catch (err) {
      const f = toFailure(err);
      emit({ type: 'error', code: f.code, message: f.message });
    } finally {
      conv.busy = false;
      conversations.touch(conv);
      clearInterval(heartbeat);
      await tools.close();
      res.end();
    }
  });

  v1.get('/conversations/:id', (req, res) => {
    const s = sessionOf(res);
    const conv = conversations.get(s.owner, req.params.id);
    if (!conv) return fail(res, 404, 'NOT_FOUND', 'Conversation not found.');
    res.json({ id: conv.id, transcript: conv.transcript, pending: conv.pending });
  });

  // New chat: discards pending drafts and ends the assistant session, so
  // this token stops working and the app starts a fresh session.
  v1.delete('/conversations/:id', async (req, res) => {
    const s = sessionOf(res);
    const conv = conversations.get(s.owner, req.params.id);
    if (conv) {
      const ids = conv.pending.flatMap((d) => d.action_ids);
      await Promise.all(ids.map((id) => s.backend.cancelAction(id).catch(() => undefined)));
      conversations.delete(s.owner, conv.id);
    }
    if (req.params.id === s.claims.agentSessionId) {
      await s.backend.endSession().catch(() => undefined);
      verified.delete(createHash('sha256').update(s.token).digest('hex'));
    }
    res.status(204).end();
  });

  const withConversation = (
    res: Response,
    owner: string,
    id: string,
  ): Conversation | undefined => {
    const conv = conversations.get(owner, id);
    if (!conv) {
      fail(res, 404, 'NOT_FOUND', 'This conversation has ended. Ask again to prepare the change.');
      return undefined;
    }
    if (conv.busy) {
      fail(res, 409, 'BUSY', 'Still answering your previous message.');
      return undefined;
    }
    return conv;
  };

  const runAction = async (
    res: Response,
    conv: Conversation,
    work: () => Promise<unknown>,
  ) => {
    conv.busy = true;
    try {
      const result = (await work()) as Record<string, unknown>;
      // Writes are charged by sms-backend; hand the app the new balance.
      const quota = await sessionOf(res)
        .backend.quota()
        .catch(() => null);
      res.json(quota ? { ...result, credits: { remaining: quota.remaining, limit: quota.limit } } : result);
    } catch (err) {
      failWith(res, err);
    } finally {
      conv.busy = false;
      conversations.touch(conv);
    }
  };

  v1.post('/actions/confirm', express.json({ limit: '8kb' }), async (req, res) => {
    const s = sessionOf(res);
    if (config.confirmMode !== 'agent') {
      return fail(
        res,
        409,
        'CONFIRM_WITH_USER_TOKEN',
        'Confirm with the user session (POST /agent/actions/:id/confirm), then call /v1/actions/execute.',
      );
    }
    const body = ActionsBody.safeParse(req.body);
    if (!body.success) return fail(res, 400, 'BAD_REQUEST', 'conversationId and actionIds are required.');
    const conv = withConversation(res, s.owner, body.data.conversationId);
    if (!conv) return;
    await runAction(res, conv, () => agent.confirm(conv, body.data.actionIds, s.backend));
  });

  v1.post('/actions/execute', express.json({ limit: '64kb' }), async (req, res) => {
    const s = sessionOf(res);
    const body = ExecuteBody.safeParse(req.body);
    if (!body.success) return fail(res, 400, 'BAD_REQUEST', 'conversationId and actions are required.');
    const conv = withConversation(res, s.owner, body.data.conversationId);
    if (!conv) return;
    await runAction(res, conv, () =>
      agent.execute(
        conv,
        body.data.actions.map((a) => ({ id: a.id, request: { ...a.request, body: a.request.body ?? null } })),
        s.backend,
      ),
    );
  });

  v1.post('/actions/cancel', express.json({ limit: '8kb' }), async (req, res) => {
    const s = sessionOf(res);
    const body = ActionsBody.safeParse(req.body);
    if (!body.success) return fail(res, 400, 'BAD_REQUEST', 'conversationId and actionIds are required.');
    const conv = withConversation(res, s.owner, body.data.conversationId);
    if (!conv) return;
    await runAction(res, conv, () => agent.cancel(conv, body.data.actionIds, s.backend));
  });

  /**
   * The school's quota and settings, or null after answering: no credits
   * left, or the backend refused.
   */
  const withCredits = async (res: Response, s: Session): Promise<Quota | null> => {
    try {
      const q = await s.backend.quota();
      if (q.remaining > 0) return q;
      fail(
        res,
        402,
        'CREDITS_EXHAUSTED',
        `This school has used all ${q.limit} AI Assistant credits for ${q.month}. An administrator can add more.`,
      );
    } catch (err) {
      failWith(res, err);
    }
    return null;
  };

  const voiceOff = (res: Response) =>
    fail(res, 503, 'VOICE_UNAVAILABLE', 'Server voice is not available; use the device voice.');

  v1.post(
    '/voice/transcribe',
    express.raw({
      type: ['audio/*', 'video/webm', 'application/octet-stream'],
      limit: config.maxAudioBytes,
    }),
    async (req, res) => {
      const s = sessionOf(res);
      const audio = req.body as Buffer;
      if (!Buffer.isBuffer(audio) || audio.length < 1000) {
        return fail(res, 400, 'NO_AUDIO', "I didn't catch anything. Try again.");
      }
      const ms = Number(req.headers['x-audio-duration-ms']);
      const seconds = Number.isFinite(ms) && ms > 0 ? ms / 1000 : audio.length / 16_000;
      if (seconds > config.maxAudioSeconds + 5) {
        return fail(res, 413, 'AUDIO_TOO_LONG', `Keep voice messages under ${config.maxAudioSeconds} seconds.`);
      }
      if (limited(res, s.owner)) return;
      const q = await withCredits(res, s);
      if (!q) return;
      const model = q.voiceInput ?? config.voiceInput;
      if (!voice.available(model)) return voiceOff(res);
      const lang = typeof req.query.lang === 'string' && /^[a-z]{2}$/.test(req.query.lang)
        ? req.query.lang
        : undefined;
      try {
        const t = await voice.transcribe(
          model,
          audio,
          String(req.headers['content-type'] ?? 'audio/webm'),
          seconds,
          lang,
        );
        await s.backend
          .reportUsage({ kind: 'STT', model, audioSeconds: t.seconds })
          .catch((e: Error) => console.error('[sms-agent] STT usage report failed', e.message));
        res.json({ text: t.text });
      } catch (err) {
        if (err instanceof VoiceUnavailable) return voiceOff(res);
        fail(res, 502, 'VOICE_FAILED', (err as Error).message);
      }
    },
  );

  v1.post('/voice/speak', express.json({ limit: '16kb' }), async (req, res) => {
    const s = sessionOf(res);
    const body = SpeakBody.safeParse(req.body);
    if (!body.success) return fail(res, 400, 'BAD_REQUEST', 'text is required.');
    const text = speakable(body.data.text, config.maxSpeakChars);
    if (!text) return fail(res, 400, 'BAD_REQUEST', 'Nothing to say.');
    const q = await withCredits(res, s);
    if (!q) return;
    const model = q.voiceOutput ?? config.voiceOutput;
    if (!voice.available(model)) return voiceOff(res);
    try {
      const audio = await voice.speak(model, q.ttsVoice ?? config.ttsVoice, text);
      await s.backend
        .reportUsage({ kind: 'TTS', model, characters: text.length })
        .catch((e: Error) => console.error('[sms-agent] TTS usage report failed', e.message));
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(audio);
    } catch (err) {
      if (err instanceof VoiceUnavailable) return voiceOff(res);
      fail(res, 502, 'VOICE_FAILED', (err as Error).message);
    }
  });

  app.use('/v1', v1);

  // Body-parser errors (too large, bad JSON) and anything unexpected.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = (err as { status?: number }).status ?? 500;
    if (status === 413) return fail(res, 413, 'TOO_LARGE', 'That is too large to send.');
    if (status === 400) return fail(res, 400, 'BAD_REQUEST', 'Malformed request.');
    console.error('[sms-agent] unhandled', err);
    if (!res.headersSent) fail(res, 500, 'INTERNAL', 'Something went wrong.');
  });

  return app;
}
