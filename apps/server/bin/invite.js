// node apps/server/bin/invite.js ["company name"]  → prints a one-time sign-up link (D20/D25, invite-only).
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const db = openDb(join(config.dataDir, 'tobira-inbox.db'));
const code = randomBytes(9).toString('base64url');
db.prepare('INSERT INTO invites (code, note) VALUES (?, ?)').run(code, process.argv[2] ?? null);
console.log(`${config.publicUrl}/signup?code=${code}`);
db.close();
