// apps/server/server.js — web entry point. Caddy terminates TLS for
// inbox.example.com and proxies here.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from './src/db.js';
import { buildApp } from './src/app.js';
import { loadConfig } from './src/config.js';
import { createAi } from './src/ai.js';
import { configurePush } from './src/push.js';

const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const db = openDb(join(config.dataDir, 'tobira-inbox.db'));
// "Draft on request" from the console; every call is metered in ai_usage.
const ai = config.anthropicApiKey ? createAi({ apiKey: config.anthropicApiKey, db }) : null;
configurePush(config); // owner questions notify from the web process
const app = buildApp({ db, config, ai });
await app.listen({ port: config.port, host: config.host });
console.log(`tobira-inbox listening on http://${config.host}:${config.port}`);
