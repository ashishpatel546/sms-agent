/**
 * Runtime configuration.
 *
 * The environment only says where things are and holds the secrets (see
 * .env.example). How the assistant behaves — chat model, voice, idle time,
 * history — is set in the hub per school and arrives from sms-backend with
 * `GET /agent/quota` before every reply; the values here are only what is
 * used if the backend does not send one. The limits below can still be
 * overridden by an environment variable of the same name in an emergency,
 * but none is needed.
 */
export interface Config {
  host: string;
  port: number;
  /** sms-backend base URL, e.g. https://api.colegios.in (no trailing slash). */
  smsApiUrl: string;
  /** sms-mcp Streamable HTTP endpoint, e.g. http://127.0.0.1:4020/mcp. */
  mcpUrl: string;
  /** Sent as X-MCP-Key; must equal MCP_SHARED_SECRET in sms-mcp. */
  mcpKey: string;
  /**
   * Browser origins allowed to call this service (CORS), as one regular
   * expression. The portal is served per school on a subdomain.
   */
  corsOriginRegex: RegExp;
  openaiApiKey: string;

  // ── Fallbacks for the hub settings ─────────────────────────────────────
  /** Chat model with tool calling. */
  model: string;
  /**
   * Used only for a reasoning model (gpt-5*, o*): gpt-5.4-* accept tools only
   * with `none`; gpt-5 / gpt-5-mini / gpt-5-nano need `minimal` or higher.
   */
  reasoningEffort: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  /** 'off' | 'device' | a speech-to-text model. */
  voiceInput: string;
  /** 'off' | 'device' | a text-to-speech model. */
  voiceOutput: string;
  ttsVoice: string;
  /** Earlier exchanges (question + answer) the model sees with a message. */
  historyMaxTurns: number;
  /** Conversation idle time; synced from the school's session idle limit. */
  conversationTtlMs: number;
  /**
   * Who confirms drafted changes; synced from sms-backend's
   * AGENT_CONFIRM_REQUIRES_USER_TOKEN:
   *   agent — this service confirms after the user presses Confirm or
   *           clearly says yes;
   *   user  — the app confirms with the user's own session token, then
   *           asks this service to run the confirmed change.
   */
  confirmMode: 'agent' | 'user';

  // ── Limits ─────────────────────────────────────────────────────────────
  maxOutputTokens: number;
  /** Model/tool rounds per user message before the assistant gives up. */
  maxToolRounds: number;
  maxAudioSeconds: number;
  maxAudioBytes: number;
  maxSpeakChars: number;
  maxMessageChars: number;
  /** Conversations kept per user; the oldest is dropped beyond this. */
  maxConversationsPerUser: number;
  /** Characters of history sent to the model — a cap on top of the turns. */
  historyBudgetChars: number;
  /** Characters of one tool result kept for the model. */
  toolResultMaxChars: number;
  /** Per user: messages (chat + voice) per rate window. */
  rateLimit: number;
  rateWindowMs: number;
  requestTimeoutMs: number;
}

function int(v: string | undefined, fallback: number): number {
  const n = v ? Number.parseInt(v, 10) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Local dev portal (<slug>.localhost:4000), the Cloudflare tunnel and production. */
const DEFAULT_ORIGINS =
  '^https?://([a-z0-9-]+\\.)*(localhost(:\\d+)?|appme\\.in|colegios\\.in)$';

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const trim = (u: string) => u.replace(/\/+$/, '');
  return {
    host: env.AGENT_HOST ?? '127.0.0.1',
    port: int(env.AGENT_PORT, 4030),
    smsApiUrl: trim(env.SMS_API_URL ?? 'http://localhost:4010'),
    mcpUrl: env.SMS_MCP_URL ?? 'http://127.0.0.1:4020/mcp',
    mcpKey: env.SMS_MCP_KEY ?? '',
    corsOriginRegex: new RegExp(env.AGENT_CORS_ORIGIN_REGEX || DEFAULT_ORIGINS),
    openaiApiKey: env.OPENAI_API_KEY ?? '',

    model: 'gpt-4.1-nano',
    reasoningEffort: 'none',
    voiceInput: 'device',
    voiceOutput: 'device',
    ttsVoice: 'coral',
    historyMaxTurns: 10,
    conversationTtlMs: 15 * 60_000,
    confirmMode: 'agent',

    maxOutputTokens: int(env.AGENT_MAX_OUTPUT_TOKENS, 1200),
    maxToolRounds: int(env.AGENT_MAX_TOOL_ROUNDS, 6),
    maxAudioSeconds: int(env.AGENT_MAX_AUDIO_SECONDS, 60),
    maxAudioBytes: int(env.AGENT_MAX_AUDIO_BYTES, 5 * 1024 * 1024),
    maxSpeakChars: int(env.AGENT_MAX_SPEAK_CHARS, 600),
    maxMessageChars: int(env.AGENT_MAX_MESSAGE_CHARS, 2000),
    maxConversationsPerUser: int(env.AGENT_MAX_CONVERSATIONS_PER_USER, 5),
    historyBudgetChars: int(env.AGENT_HISTORY_BUDGET_CHARS, 24_000),
    toolResultMaxChars: int(env.AGENT_TOOL_RESULT_MAX_CHARS, 6_000),
    rateLimit: int(env.AGENT_RATE_LIMIT, 30),
    rateWindowMs: int(env.AGENT_RATE_WINDOW_SECONDS, 300) * 1000,
    requestTimeoutMs: int(env.AGENT_REQUEST_TIMEOUT_MS, 20_000),
  };
}
