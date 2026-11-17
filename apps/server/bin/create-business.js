// node apps/server/bin/create-business.js "<name>" [owner-email]
// Creates a business (and its owner user) and prints the id used in the connect link.
import { join } from 'node:path';
import { openDb } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { newId } from '../src/store.js';

const [name, ownerEmail] = process.argv.slice(2);
if (!name) { console.error('usage: create-business.js "<name>" [owner-email]'); process.exit(2); }
const db = openDb(join(loadConfig().dataDir, 'tobira-inbox.db'));
const existing = db.prepare('SELECT id FROM businesses WHERE name = ?').get(name);
const id = existing?.id ?? newId();
if (!existing) db.prepare("INSERT INTO businesses (id, name, status) VALUES (?, ?, 'active')").run(id, name);
if (ownerEmail) {
  db.prepare("INSERT OR IGNORE INTO users (id, business_id, email, role) VALUES (?, ?, ?, 'owner')").run(newId(), id, ownerEmail.toLowerCase());
}
console.log(id);
db.close();
