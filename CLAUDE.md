# CLAUDE.md

AI Assistant host: chat (SSE) and voice for staff/admin in the school portal, using the sms-mcp tools, with human-in-the-loop confirmation and per-school credit metering via sms-backend. See README.md.

## Commands

```bash
npm run dev        # tsx watch, reads ./.env (local port 4030)
npm test           # vitest
npm run typecheck
npm run build      # tsc -> dist/
```

## Config

`src/env.ts` loads `./.env` if present (variables already in the environment win); `src/config.ts` reads it. The environment holds only locations and secrets (`.env.example`); model, voice, idle time and history are set per school in the hub and arrive from sms-backend. The process exits at startup without `OPENAI_API_KEY`. Conversations are kept in memory, so run exactly one process.

## Ports: local dev vs deployed (read before touching any port)

- Local: 4030, published through the Cloudflare tunnel as `agent-api.appme.in` (`~/.cloudflared/config.yml`).
- Deployed: stage 3041, production 3040 — from SSM `AGENT_PORT`. Bound to `127.0.0.1`, reached only through nginx.
- **Never change deployed settings to match local**, and do not touch AWS (SSM, EC2) or stage/production unless the user explicitly asks for that action in the current conversation.

## Deployment

GitHub Actions `.github/workflows/deploy-ec2.yml`, same pattern as the other repos:

- Runs only on a push to `development` (stage, GitHub environment `development`) or `main` (production, repo-level secrets). No PR triggers; merging a PR is the push that deploys.
- Runner: `npm ci`, `npm test`, `npm run build`, then SCP `dist/`, `scripts/fetch-aws-ssm.mjs`, `package*.json`, `ecosystem.config.cjs` to `/home/deployer/sms-agent-<env>/`.
- Server: `npm ci --omit=dev`, `node scripts/fetch-aws-ssm.mjs` writes `.env` from SSM `/sms-agent/<env>/*` (instance role `ec2-ssm-role`), PM2 start/restart as `sms-agent-<env>`, `pm2 save`, then the job fails unless `http://127.0.0.1:$AGENT_PORT/healthz` answers.
- PM2: one fork-mode process (`ecosystem.config.cjs`, `max_memory_restart: 400M`). Logs are rotated by the server's `pm2-logrotate` module.
- SSM `/sms-agent/development/`: `AGENT_HOST=127.0.0.1`, `AGENT_PORT=3041`, `SMS_API_URL=https://sms-dev-api.colegios.in` (the backend's public domain, as the other services use), `SMS_MCP_URL=http://127.0.0.1:3031/mcp` (sms-mcp is internal, same server), `SMS_MCP_KEY` (SecureString, equals sms-mcp's `MCP_SHARED_SECRET`), `OPENAI_API_KEY` (SecureString, the same key as `/school-ai/<env>/OPENAI_API_KEY`).
- The portal finds it through `AGENT_API_URL` in SSM `/sms-frontend/<env>/`.

### Domain, nginx, TLS

- Stage: `https://agent-dev-api.colegios.in` → Cloudflare DNS A record → `43.205.108.45` (DNS only, grey cloud) → nginx site `/etc/nginx/sites-available/agent-dev-api.colegios.in` → `127.0.0.1:3041`. Let's Encrypt cert via certbot.
- Production (not set up yet): `agent-api.colegios.in` → A record `13.207.109.49` (already added) → nginx → `127.0.0.1:3040`; SSM `/sms-agent/production/` with `SMS_API_URL=https://sms-api.colegios.in`, `SMS_MCP_URL=http://127.0.0.1:3030/mcp`.
- nginx site needs: `proxy_buffering off` (chat is SSE), `proxy_read_timeout 180s`, `client_max_body_size 8m` (voice).
- **Write the 443 server block yourself before running certbot**, then use `certbot certonly --nginx -d <host>` (or `--nginx` only once the 443 block exists). With only a port-80 block, certbot installs the cert into the `*.colegios.in` wildcard block and replaces that block's `colegios.in` certificate.
- colegios.in DNS is plain Cloudflare DNS, not cloudflared: the cloudflared CLI can only create tunnel CNAMEs, which would route to the local dev tunnel.
