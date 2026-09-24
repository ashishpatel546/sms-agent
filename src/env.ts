import { existsSync } from 'node:fs';

// Local development: read ./.env if present. Variables already set in the
// environment (as in deployed environments) take precedence.
if (existsSync('.env')) process.loadEnvFile('.env');
