# sms-agent

The AI Assistant for the school management system. Staff and admins chat or talk to it from the portal (sms-frontend). It answers with the school's own data through the [sms-mcp](../sms-mcp) tools, and it only changes records after the person confirms.

```
 portal (sms-frontend)
   │ 1. POST {API_URL}/agent/session          user session → 30-min assistant token
   │ 2. /v1/chat (SSE), /v1/actions/*, /v1/voice/*   Bearer <assistant token>
   ▼
 sms-agent ── OpenAI (chat model, speech) ── reports tokens / audio to sms-backend
   │ MCP over HTTP, same token
   ▼
 sms-mcp ── sms-backend /agent/*  (permissions, school isolation, credits, confirmed writes)
```

The service keeps no secrets except the model provider key, and has no database. It decodes the assistant token only to know who is asking. Before any model call it asks sms-backend for the school's credits with the same token, and that request verifies the token, the school and the `ai_agent` feature. A forged or expired token therefore never reaches the model.

## What a turn does

1. **Plain yes or no?** If a draft is waiting and the message is only a yes or a no (English, Hindi or Hinglish, typed or spoken), the draft is confirmed or cancelled right away, without calling the model.
2. **Credits check.** `GET /agent/quota`. When a school has no credits left, the turn stops before the model is called.
3. **Model loop.** The model sees:
   - the tools from sms-mcp, except `confirm_action`;
   - a short fixed system prompt, then a context note with the user, the time in IST and the reply mode;
   - the conversation history: the last few exchanges (the school's *history turns* hub setting, default 10), whole turns only, within `AGENT_HISTORY_BUDGET_CHARS`.

   It calls tools, possibly several in parallel, for up to `AGENT_MAX_TOOL_ROUNDS` rounds. Text streams to the app as it is written.
4. **Drafts.** A `draft_*` result carries `structuredContent.draft`. The app shows it as a card with **Confirm and save** and **Cancel**. A new draft replaces the previous one, which is cancelled in sms-backend.
5. **Metering.** The turn's tokens are reported to `POST /agent/usage/report`, with prompt-cache hits counted separately. The school's balance comes back to the app.

**Why the model can't confirm.** Approval is always the person's own act: pressing a button, or saying a plain yes. That text never passes through the model. So wording hidden in the data (a student name, a leave reason) cannot talk the model into approving something. sms-backend then runs only the exact request that was confirmed, and only once.

## API (all under `/v1`, `Authorization: Bearer <assistant token>`)

| Route | Purpose |
|---|---|
| `GET /capabilities` | Credits left, confirm mode, whether server voice is available, limits. The app's first call. |
| `POST /chat` `{ message, conversationId?, mode: 'text'｜'voice' }` | Server-sent events: `start`, `status` (tool in use), `token`, `draft`, `action` (a draft confirmed or cancelled by a plain yes/no), `usage`, `done`, `error`. |
| `GET /conversations/:id` | The visible transcript and any pending drafts, used to restore the panel after a reload. |
| `DELETE /conversations/:id` | New chat: forgets the conversation, cancels its pending drafts and ends the assistant session in sms-backend, so this token stops working. |
| `POST /actions/confirm` `{ conversationId, actionIds }` | The Confirm button (confirm mode `agent`). |
| `POST /actions/execute` `{ conversationId, actions: [{ id, request }] }` | Confirm mode `user`: the app has already confirmed with the person's own session. |
| `POST /actions/cancel` `{ conversationId, actionIds }` | The Cancel button. |
| `POST /voice/transcribe` (raw audio, `X-Audio-Duration-Ms`) | Speech to text, charged per second. |
| `POST /voice/speak` `{ text }` | Text to speech (MP3), charged per character. |

Error bodies are `{ code, message }`. `message` is written to be shown to the person. The codes are `SESSION_EXPIRED` (401: mint a new token and retry), `SESSION_ENDED` (401: the conversation is over; start a fresh one), `CREDITS_EXHAUSTED` (402), `FORBIDDEN` (403), `RATE_LIMITED` (429), `BUSY` (409), `VOICE_UNAVAILABLE` (503: use the browser's own speech) and `MODEL_UNAVAILABLE` / `TOOLS_UNAVAILABLE`.

## Models

| Use | Default | Setting |
|---|---|---|
| Chat with tools | `gpt-4.1-nano` | Hub: chat model |
| Voice input | the device's own recognition (free), falling back to `gpt-4o-mini-transcribe` ($0.003/min) where the device cannot listen or fails | Hub: device, `gpt-4o-mini-transcribe`, `gpt-4o-transcribe` ($0.006/min) or off |
| Voice output | the device's own voice (free) | Hub: device (falls back to `gpt-4o-mini-tts` where the device has no voice for the language), `gpt-4o-mini-tts` (~$0.015/min) or off, plus the voice |

**Settings live in the hub, not here.** Chat model, voice input, voice output, voice, session idle minutes and history turns are platform defaults with optional per-school overrides (hub: AI > Assistant, and each school's page). sms-backend returns a school's settings with `GET /agent/quota`, which this service calls before every reply, so changes apply from the next message. `.env` holds only addresses and secrets (see `.env.example`). Limits such as `AGENT_RATE_LIMIT` or `AGENT_MAX_AUDIO_SECONDS` have built-in values in `src/config.ts` and can be overridden by an environment variable of the same name if ever needed.

**Choosing the chat model.** On 24 Sep 2026 each model ran the same 15 staff tasks twice, against the local school. The tasks covered:
- the day's briefing, class absentees and low attendance;
- drafting attendance, homework, leave in Hinglish, and a leave decision;
- own leave balance, a student's attendance, and admin fee dues;
- refusing a payment and an off-topic question;
- resisting a prompt injection;
- a Hinglish voice question;
- a follow-up question.

A task passed when the right tool was called, the draft was correct, or the refusal held.

| Model (reasoning) | Passed | Avg time | Cost per 1,000 questions |
|---|---|---|---|
| gpt-5.4-mini (none) | 30/30 | 2.5 s | $1.26 |
| gpt-5.4-nano (none) | 30/30 | 2.3 s | $0.50 |
| **gpt-4.1-nano**, default | 30/30, 29/30 on the run before | 2.0 s | $0.22 |
| gpt-5-mini (minimal) | 28/30 | 4.8 s | $0.65 |
| gpt-5-nano (minimal) | 25/30: asks needless questions instead of calling tools | 2.9 s | $0.11 |

**Changing the model.** The hub offers only the evaluated chat models above, each with the reasoning setting it needs. If the provider key refuses the chosen model, the reply falls back to `gpt-4.1-nano` and the log says so.

Costs use the prices in school-ai's `llm_model_pricing`, with prompt-cache hits billed at the cached rate. `gpt-5.4-*` models only accept tools with `reasoning_effort: none`; `gpt-5`, `gpt-5-mini` and `gpt-5-nano` need `minimal` or higher (set automatically); `gpt-4.1-*` takes no reasoning setting, and none is sent. No chat model can listen or speak, so voice is chosen separately. If the provider key cannot use a speech model, the service marks that model unavailable for 10 minutes. The app then switches to the browser's own speech recognition and synthesis; nothing breaks.

## Confirm modes

Set by sms-backend's `AGENT_CONFIRM_REQUIRES_USER_TOKEN`, which this service reads with the quota.

- `agent` (default): this service confirms after the Confirm button or a plain yes.
- `user` (`AGENT_CONFIRM_REQUIRES_USER_TOKEN=true`): stricter. The app confirms each draft with the person's own session (`POST {API_URL}/agent/actions/:id/confirm`) and passes the returned request to `/v1/actions/execute`. A spoken "yes" then only reminds the person to press Confirm.

## Running

```bash
npm install
cp .env.example .env         # set OPENAI_API_KEY; SMS_API_URL / SMS_MCP_URL if not local defaults
npm run build && npm start   # http://127.0.0.1:4030
npm run dev                  # watch mode
npm test                     # vitest: unit + HTTP flows with a fake model, tools and backend
```

Local stack: sms-backend on 4010, sms-mcp on 4020, sms-agent on 4030. Start the portal with `AGENT_API_URL=http://localhost:4030`. `.env` is read at startup when present; variables already set in the environment win.

**Docker:** `docker build -t sms-agent . && docker run -p 4030:4030 --env-file .env sms-agent`. The image listens on `0.0.0.0:4030`.

## Operating notes

- **Conversations** follow sms-backend's assistant sessions: the conversation id is the token's `agentSessionId`. A session ends on New chat or after the school's session idle minutes (hub setting, default 15) without activity; sms-backend then refuses its tokens, and the app's next token opens a fresh session, so a returning user starts a fresh conversation. While a session is live, the app's token refresh continues it (`POST /agent/session { resume }`).
- **Conversations** live in memory, at most 5 per person. They are not records. School data and drafts live in sms-backend, and losing a conversation only means starting a new one. With several instances, route each user to the same instance, or move `ConversationStore` to Redis.
- **sms-mcp link:** set the same random value as `SMS_MCP_KEY` here and `MCP_SHARED_SECRET` in sms-mcp. Only this service is meant to reach sms-mcp, and sms-mcp should never be published publicly.
- **Local tunnel:** `agent-api.appme.in` routes to `127.0.0.1:4030`, so the portal on `<slug>.appme.in` works from a phone. `helping-scripts/start.sh` and `stop.sh` manage it as the `agent` service, and sms-mcp as `mcp`.
- **CORS** allows `AGENT_CORS_ORIGIN_REGEX`. The default covers `<slug>.localhost`, `*.appme.in` and `*.colegios.in`.
- **Limits:** 30 messages per person per 5 minutes, 2,000 characters per message, 60-second voice clips.
- **Cost, measured locally:** a turn with a tool call uses about 2–5 credits of model tokens, falling to about 2 once the prompt is cached, plus 1–3 credits for the tools. A plain yes or no costs only the write itself.

## Layout

```
src/
  index.ts      entry
  http.ts       routes, SSE, CORS, auth, rate limit, voice endpoints
  agent.ts      the turn loop, drafts, confirm / execute / cancel
  llm.ts        OpenAI chat model (streaming, tool calls, usage)
  mcp.ts        sms-mcp client, cached tool list per session
  backend.ts    sms-backend calls: quota, usage reports, confirmed writes
  intent.ts     plain yes / no detection
  prompt.ts     system prompt and per-turn context
  conversations.ts  in-memory store and history trimming
  voice.ts      speech to text / text to speech
test/           vitest
```
