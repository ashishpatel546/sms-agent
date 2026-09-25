// PM2 config for deployed environments. The app reads its settings from .env
// (written from AWS SSM by scripts/fetch-aws-ssm.mjs). One fork-mode
// instance: conversations live in memory, so they must not be split across a
// cluster.
module.exports = {
  apps: [
    {
      name: process.env.PM2_NAME || 'sms-agent-production',
      script: 'dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '400M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
