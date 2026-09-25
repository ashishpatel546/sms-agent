// Deploy helper: writes .env from AWS SSM (/sms-agent/<env>/*). Run by the
// deploy workflow on the server before PM2 restarts the app; the app then
// reads .env itself at startup (src/env.ts). Credentials come from the
// instance role.
import { SSMClient, GetParametersByPathCommand } from '@aws-sdk/client-ssm';
import fs from 'node:fs';

const env = process.env.SSM_ENV || 'development';
const path = `/sms-agent/${env}/`;
console.log(`🔄 Fetching env from AWS SSM ${path}`);

const client = new SSMClient({ region: process.env.AWS_REGION || 'ap-south-1' });

const params = [];
let NextToken;
do {
  const res = await client.send(
    new GetParametersByPathCommand({ Path: path, WithDecryption: true, Recursive: true, NextToken }),
  );
  params.push(...(res.Parameters ?? []));
  NextToken = res.NextToken;
} while (NextToken);

if (params.length === 0) {
  console.error(`❌ No parameters under ${path}`);
  process.exit(1);
}

const lines = params
  .map((p) => [p.Name.slice(path.length), p.Value])
  .filter(([key, value]) => key && !key.includes('/') && value !== undefined)
  .map(([key, value]) => `${key}=${JSON.stringify(value)}`);

fs.writeFileSync('.env', `${lines.join('\n')}\n`, { mode: 0o600 });
console.log(`✅ Wrote .env with ${lines.length} keys`);
