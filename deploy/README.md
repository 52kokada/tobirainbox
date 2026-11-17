# deploy/

Example files for running TobirAInbox on a single Linux host under systemd, behind Caddy. Adjust names, paths and the domain
(`inbox.example.com` below is a placeholder) to your setup.

- `tobira-inbox.service` - the API (port 8960, bound to 127.0.0.1).
- `tobira-inbox-worker.service` - the mailbox worker (check + sort, drafting). It exits with code 2 until the required `.env` values exist.
- `tobira-inbox-agreement.service` / `.timer` - optional daily read-only comparison of the sorter with an external CRM's verdicts.
- `Caddyfile.snippet` - TLS reverse proxy for the API.
- `deploy-tobira-inbox.sh` + `tobira-inbox-deploy.cron` - optional pull-and-restart with a health gate and rollback.

Outline (as root):
1. Create a system user and clone the repo to `/opt/tobira-inbox`; run `npm ci --omit=dev` as that user.
2. Write `/opt/tobira-inbox/.env` (mode 600): `PORT`, `HOST=127.0.0.1`, `DATA_DIR`, `PUBLIC_URL=https://inbox.example.com`,
   `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SECRETS_MASTER_KEY` (32 random bytes, base64), `ADMIN_TOKEN`, `ANTHROPIC_API_KEY`.
   An optional second Google client for outside businesses uses `GOOGLE_EXT_CLIENT_ID` / `GOOGLE_EXT_CLIENT_SECRET`.
3. Install the systemd units, enable the API and the worker, append `Caddyfile.snippet` to your Caddyfile and reload Caddy.
4. Point DNS for your domain at the host.
5. Create the business: `node apps/server/bin/create-business.js "Example Studio" owner@example.com`, then open the connect link
   `https://inbox.example.com/connect/google?business=<id>&key=<ADMIN_TOKEN>&login_hint=<mailbox>`.
6. Load voices, playbook and facts: `node apps/server/bin/seed.js apps/server/seeds/example.json`.
7. Optional: install the deploy script and cron; the review page is `https://inbox.example.com/admin/drafts?key=<ADMIN_TOKEN>`.
