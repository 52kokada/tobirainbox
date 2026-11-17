# TobirAInbox

TobirAInbox is a reply console for small-business Gmail accounts. It classifies incoming mail,
drafts replies with Claude in each mailbox's writing style, and sends a reply only after a
person has reviewed the draft and clicked Send.

It handles Japanese business mail first (honorifics, Japan time), and English second.

## Features

- Classification of each incoming message into one of these labels: inquiry, booking, change
  or cancellation, question, complaint, decline, opt-out, sales pitch, notice, spam,
  auto-reply, unconfirmed, other. A business can rename them and add its own. Fixed rules run
  before the model, and a person's corrections are given to the model for similar mail.
- Drafts written from the business's playbook, stored facts, earlier replies and the thread.
- A grounding check on every draft. A price, URL or phone number that does not appear in the
  business's facts or in the thread is replaced with a 【要確認】 (needs checking) blank.
- Detection of dates, deadlines and meeting requests, including time zones and calendar
  invites, with optional holds on Google Calendar.
- Sending with an undo window (30 seconds by default) or at a scheduled time.
- Web push notifications for mail that needs a person.
- Several businesses in one installation. Every database query is scoped by business.
- A daily AI spend limit for each business, with the cost of every model call recorded.

## Requirements

- Node.js 20 or later
- For real mailboxes: a Google OAuth client with Gmail access, and an Anthropic API key

## Quick start

The preview runs with an in-memory database, a fake mailbox and a fake model. It needs no
Google account and no API key, and makes no network calls.

```
git clone https://github.com/52kokada/tobirainbox.git
cd tobirainbox
npm install
npm run preview
```

Open `http://127.0.0.1:8961/dev`. The page signs in as the owner of a demo business.

## Configuration

The server reads environment variables in `apps/server/src/config.js`. The main variables are:

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client for sign-in and Gmail |
| `ANTHROPIC_API_KEY` | Model calls |
| `SECRETS_MASTER_KEY` | Encrypts stored Gmail tokens |
| `PUBLIC_URL` | The address the server is reached at |
| `DATA_DIR` | Location of the SQLite database |
| `AI_DAILY_CAP_USD` | Default daily AI spend limit |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web push |
| `COCKPIT_EVENTS_URL`, `COCKPIT_EVENTS_TOKEN`, `COCKPIT_TENANT` | Optional external CRM backend |

`config.js` lists the others, including the port and the polling interval.

## Running

```
npm start
```

The server listens on `http://127.0.0.1:8960`. `/healthz` reports its status.
[deploy/README.md](deploy/README.md) describes a deployment on one Linux host with systemd and
Caddy.

## Security

Gmail refresh tokens are encrypted at rest with `SECRETS_MASTER_KEY`.

`apps/server/src/send-queue.js` is the only code path that sends mail. It enforces these rules:

1. A send requires a signed-in user who belongs to the same business.
2. A draft that still contains a 【要確認】 blank cannot be queued.
3. One draft version can be queued once, so a double click or a retry does not send twice.
4. Nothing is sent before the undo window ends. Cancelling before then stops the send.
5. A mailbox in shadow mode does not send. New mailboxes start in shadow mode.
6. A partner account sends only from a mailbox that an owner has allowed.
7. A scheduled send waits for its time. If a newer message arrives in the thread first, the
   send is held.

Before a draft and its reply are stored as an example for later drafts, email addresses and
phone numbers are removed (`packages/engine/src/redact.js`).

To report a vulnerability, open a private security advisory on this repository.

## Project layout

| Path | Contents |
|---|---|
| `packages/engine` | Logic with no I/O: classification, draft prompt, grounding check, blanks, redaction, date detection, reply MIME |
| `apps/server` | Fastify API, SQLite store and migrations, Gmail and Calendar clients, send queue, worker, browser app in `public/` |
| `design/dev-server.mjs` | The preview server |
| `design/prototype` | Static interface mock |
| `deploy/` | Example systemd, Caddy and cron files |

The browser app is plain JavaScript and has no build step.

## Testing

```
npm test
```

352 tests run with the Node test runner: 109 in `packages/engine` and 243 in `apps/server`.
They use an in-memory database and fake Gmail and model clients.

### Date detection eval

```
npm run eval:dates -- --split=test --model=claude-haiku-5-5 --effort=low
```

The eval runs the date detector on fixture threads that are split once into `train` and `test`.
Every check is pass/fail code; no model grades the output. It prints the pass rate and the cost
per 100 messages. A model or effort setting is accepted when the `test` split stays at 95% or
higher. Without `--model` or an API key, only the deterministic parts run.

## Project status

TobirAInbox is used internally by one business. The Google OAuth client for outside accounts
has not been through Google's verification.

This repository is a public copy of a private working repository. Businesses, people and email
addresses in tests, fixtures and demo data are invented.

## Third-party components

`apps/server/public/vendor/` contains interface components from Magic UI and Motion Primitives
under the MIT licence. Each folder includes its NOTICE file.

## License

[MIT](LICENSE)
