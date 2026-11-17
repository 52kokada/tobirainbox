// apps/server/src/app.js — Fastify app: console (static PWA + /api), sign-in,
// mailbox connect, staff admin pages.
import Fastify from 'fastify';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { registerConnectRoutes } from './routes/connect.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerApiRoutes } from './routes/api.js';
import { registerAuthRoutes } from './auth.js';
import { registerLearnRoutes } from './routes/learn.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerPushRoutes } from './routes/push.js';
import { registerCalendarRoutes } from './routes/calendar.js';
import { registerManagerRoutes } from './routes/manager.js';
import { calendarFor } from './calendar.js';
import { SaTokens, signerFromConfig } from './sa-token.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const require = createRequire(import.meta.url);
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
  '/calendar.js': ['calendar.js', 'text/javascript; charset=utf-8'],
  '/ui.js': ['ui.js', 'text/javascript; charset=utf-8'],
  '/logo.js': ['logo.js', 'text/javascript; charset=utf-8'],
  '/theme.js': ['theme.js', 'text/javascript; charset=utf-8'],
  '/time.js': ['time.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/sw.js': ['sw.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/og.png': ['og.png', 'image/png'],
};

export function buildApp({ db, config = {}, version = '0.5.0', exchange, ai = null, gmailFactory, websiteFetcher, pushSend, calendarClientFor, meetWait } = {}) {
  // Gmail attachment ids run to ~400 characters; Fastify's default 100-character param limit refused
  // /api/threads/:id/files/:mid/:aid, so received files could not be opened.
  const app = Fastify({ logger: false, trustProxy: true, maxParamLength: 1000 });
  app.decorate('db', db);
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' },
    (req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body))));

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    if (String(reply.getHeader('content-type') ?? '').startsWith('text/html')) {
      reply.header('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
    }
    return payload;
  });

  app.get('/healthz', async () => {
    const ok = db.prepare('SELECT 1 AS ok').get()?.ok === 1;
    return { ok, service: 'tobira-inbox', version };
  });

  for (const [path, [file, type]] of Object.entries(STATIC)) {
    app.get(path, async (req, reply) => {
      const p = join(PUBLIC, file);
      if (!existsSync(p)) return reply.code(404).send('not found');
      // Always revalidate: a deploy must reach open consoles immediately (files are small).
      reply.header('cache-control', 'no-cache');
      return reply.type(type).send(readFileSync(p));
    });
  }
  app.get('/vendor/htm-preact.js', async (req, reply) => {
    const p = join(dirname(require.resolve('htm')), '..', 'preact', 'standalone.module.js');
    reply.header('cache-control', 'public, max-age=86400');
    return reply.type('text/javascript; charset=utf-8').send(readFileSync(p));
  });

  // Motion components from the TOBIRA edition of Magic UI / Motion Primitives (MIT; NOTICE.txt beside each).
  const TB_FILES = { 'component.css': 'text/css; charset=utf-8', 'component.js': 'text/javascript; charset=utf-8', 'NOTICE.txt': 'text/plain; charset=utf-8' };
  app.get('/vendor/tobira/:comp/:file', async (req, reply) => {
    const { comp, file } = req.params;
    if (!/^[a-z0-9-]+$/.test(comp) || !TB_FILES[file]) return reply.code(404).send('not found');
    const p = join(PUBLIC, 'vendor', 'tobira', comp, file);
    if (!existsSync(p)) return reply.code(404).send('not found');
    reply.header('cache-control', 'no-cache');
    return reply.type(TB_FILES[file]).send(readFileSync(p));
  });

  registerAuthRoutes(app, { db, config, ...(exchange ? { exchange } : {}) });
  registerConnectRoutes(app, { db, config, ...(exchange ? { exchange } : {}) });
  registerAdminRoutes(app, { db, config });
  registerApiRoutes(app, { db, config, ai, gmailFactory });
  registerSettingsRoutes(app, { db, config });
  registerLearnRoutes(app, { db, config, ai, gmailFactory, websiteFetcher, pushSend });
  registerPushRoutes(app, { db, config });
  const clientFor = calendarClientFor ?? lazyCalendarClient(db, config);
  registerCalendarRoutes(app, { db, config, ai, gmailFactory, meetWait, clientFor });
  registerManagerRoutes(app, { db, config, gmailFactory, meetWait, clientFor });
  return app;
}

/** calendarFor bound to the service-account tokens, built on first use so a bad GOOGLE_SA_KEY never stops the server. */
function lazyCalendarClient(db, config) {
  let saTokens;
  return (mailbox) => {
    if (saTokens === undefined) {
      const signer = signerFromConfig({ db, config });
      saTokens = signer ? new SaTokens({ db, config, signer }) : null;
    }
    return calendarFor(mailbox, { db, config, saTokens });
  };
}
