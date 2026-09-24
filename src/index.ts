import './env.js';
import { loadConfig } from './config.js';
import { createApp, SERVICE } from './http.js';
import { OpenAiChatModel } from './llm.js';

const config = loadConfig();
if (!config.openaiApiKey) {
  console.error('[sms-agent] OPENAI_API_KEY is not set.');
  process.exit(1);
}

const app = createApp({ config, model: new OpenAiChatModel(config) });
const server = app.listen(config.port, config.host, () => {
  console.log(
    `[sms-agent] ${SERVICE.version} on http://${config.host}:${config.port} — model ${config.model}, tools ${config.mcpUrl}, backend ${config.smsApiUrl}`,
  );
});

// Streaming replies can run long; don't cut them at Node's defaults.
server.requestTimeout = 5 * 60_000;
server.headersTimeout = 65_000;

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
