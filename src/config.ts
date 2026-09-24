/** Runtime configuration, read once from the environment. */
export interface Config {
  host: string;
  port: number;
  /** sms-backend base URL, e.g. https://api.colegios.in (no trailing slash). */
  smsApiUrl: string;
  /** sms-mcp Streamable HTTP endpoint, e.g. http://127.0.0.1:4020/mcp. */
  mcpUrl: string;
  /**
   * Browser origins allowed to call this service (CORS), as one regular
   * expression. The portal is served per school on a subdomain.
   */
  corsOriginRegex: RegExp;

  openaiApiKey: string;
  /** Chat model with tool calling. */
  model: string;
  reasoningEffort: 'none' | 'low' | 'medium' | 'high';
  maxOutputTokens: number;
  /** Model/tool rounds per user message before the assistant gives up. */
  maxToolRounds: number;
  /** Empty disables server-side voice; the browser's own speech is used. */
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  maxAudioSeconds: number;
  maxAudioBytes: number;
  maxSpeakChars: number;

  /**
   * Who confirms drafted changes, and must match sms-backend's
   * AGENT_CONFIRM_REQUIRES_USER_TOKEN:
   *   agent — this service confirms after the user presses Confirm or
   *           clearly says yes (default);
   *   user  — the app confirms with the user's own session token, then
   *           asks this service to run the confirmed change.
   */
  confirmMode: 'agent' | 'user';

  maxMessageChars: number;
  /** Idle time after which a conversation is forgotten. */
  conversationTtlMs: number;
  /** Conversations kept per user; the oldest is dropped beyond this. */
  maxConversationsPerUser: number;
  /** Characters of history sent to the model (older turns are dropped). */
  historyBudgetChars: number;
  /** Characters of one tool result kept for the model. */
  toolResultMaxChars: number;
  /** Per user: messages (chat + voice) per rate window. */
  rateLimit: number;
  rateWindowMs: number;
  requestTimeoutMs: number;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function int(v: string | undefined, fallback: number): number {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

function oneOf<T extends string>(
  v: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(v as T) ? (v as T) : fallback;
}

/** Local dev portal (<slug>.localhost:4000), the Cloudflare tunnel and production. */
const DEFAULT_ORIGINS =
  '^https?://([a-z0-9-]+\\.)*(localhost(:\\d+)?|appme\\.in|colegios\\.in)$';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const trim = (u: string) => u.replace(/\/+$/, '');
  const voice = bool(env.AGENT_VOICE_ENABLED, true);
  return {
    host: env.AGENT_HOST ?? '127.0.0.1',
    port: int(env.AGENT_PORT, 4030),
    smsApiUrl: trim(env.SMS_API_URL ?? 'http://localhost:4010'),
    mcpUrl: env.SMS_MCP_URL ?? 'http://127.0.0.1:4020/mcp',
    corsOriginRegex: new RegExp(env.AGENT_CORS_ORIGIN_REGEX || DEFAULT_ORIGINS),

    openaiApiKey: env.OPENAI_API_KEY ?? '',
    model: env.AGENT_MODEL || 'gpt-5.4-mini',
    reasoningEffort: oneOf(
      env.AGENT_REASONING_EFFORT,
      ['none', 'low', 'medium', 'high'] as const,
      'low',
    ),
    maxOutputTokens: int(env.AGENT_MAX_OUTPUT_TOKENS, 1200),
    maxToolRounds: int(env.AGENT_MAX_TOOL_ROUNDS, 6),
    sttModel: voice ? (env.AGENT_STT_MODEL ?? 'gpt-4o-mini-transcribe') : '',
    ttsModel: voice ? (env.AGENT_TTS_MODEL ?? 'gpt-4o-mini-tts') : '',
    ttsVoice: env.AGENT_TTS_VOICE || 'coral',
    maxAudioSeconds: int(env.AGENT_MAX_AUDIO_SECONDS, 60),
    maxAudioBytes: int(env.AGENT_MAX_AUDIO_BYTES, 5 * 1024 * 1024),
    maxSpeakChars: int(env.AGENT_MAX_SPEAK_CHARS, 600),

    confirmMode: oneOf(env.AGENT_CONFIRM_MODE, ['agent', 'user'] as const, 'agent'),

    maxMessageChars: int(env.AGENT_MAX_MESSAGE_CHARS, 2000),
    conversationTtlMs: int(env.AGENT_CONVERSATION_TTL_MINUTES, 240) * 60_000,
    maxConversationsPerUser: int(env.AGENT_MAX_CONVERSATIONS_PER_USER, 5),
    historyBudgetChars: int(env.AGENT_HISTORY_BUDGET_CHARS, 24_000),
    toolResultMaxChars: int(env.AGENT_TOOL_RESULT_MAX_CHARS, 6_000),
    rateLimit: int(env.AGENT_RATE_LIMIT, 30),
    rateWindowMs: int(env.AGENT_RATE_WINDOW_SECONDS, 300) * 1000,
    requestTimeoutMs: int(env.AGENT_REQUEST_TIMEOUT_MS, 20_000),
  };
}
