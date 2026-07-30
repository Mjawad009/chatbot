# n8n on Contabo VPS — setup for Insight Bot lead automation

> **Using Railway instead (since the backend's going there too)?** See
> [`RAILWAY.md`](./RAILWAY.md) — simpler for a starting point, one-click
> template, no server management. This file is for the self-hosted VPS
> route if you want full infrastructure control instead.

Verified against current n8n docs and a Contabo-specific guide (Docker Compose +
domain + reverse proxy is the standard, recommended approach as of mid-2026).
**Not tested against a live instance in this session** — I don't have a real
n8n install to import the workflow into and click through, so treat the
workflow JSON as a solid starting point to inspect and adjust, not a
guaranteed one-click import. The manual build steps at the bottom are the
reliable fallback if import has any issues.

## What you need first
- A Contabo VPS (their cheapest Cloud VPS tier is enough for this volume —
  n8n itself recommends 2GB+ RAM)
- A domain or subdomain (e.g. `n8n.yourdomain.com`) — **required**, not
  optional. n8n's webhook URLs need real HTTPS, and Caddy needs a resolvable
  domain to issue a certificate. Point an A record at your VPS's IP before
  starting anything.

## 1. Install Docker on the VPS
```bash
ssh root@your-vps-ip
apt update && apt upgrade -y
apt install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
docker --version && docker compose version
```

## 2. Deploy n8n
```bash
mkdir -p ~/n8n && cd ~/n8n
# copy docker-compose.yml, Caddyfile, and .env.example from this folder up to the VPS (scp, or just paste them)
cp .env.example .env
nano .env   # fill in N8N_HOST and generate N8N_ENCRYPTION_KEY (openssl rand -hex 24)
docker compose up -d
docker compose logs -f n8n   # watch for errors, Ctrl+C once it looks healthy
```

Visit `https://n8n.yourdomain.com` — Caddy handles the certificate
automatically the first time it starts. You'll be prompted to create an
owner account. **Do this immediately**, and use a strong password — this
account has access to every credential (SMTP passwords, API tokens) you'll
store in n8n.

SQLite (the default, no extra config) is fine at this volume — one
consultancy's booking/escalation notifications, not hundreds of workflow
executions a day. If that ever changes, Postgres is a config change, not a
rebuild — worth knowing, not worth doing now.

## 3. Import the starter workflow
In n8n: **Workflows → Import from File** → `workflows/insight-bot-lead-handler.json`.

Then, for each node that needs it:
- **Webhook** node → set Authentication to Header Auth → create a new
  credential (any name/value pair — this is the secret your Insight Bot
  backend will send back). Copy this exact name/value, you'll need it in
  step 5.
- **Email - Booking** / **Email - Escalation** nodes → set your SMTP
  credential (Gmail app password works the same way as it does in Insight
  Bot's own `email.js` notifier — same setup, different place it lives).
  Fill in real `toEmail` addresses.
- **WhatsApp Notify** node → replace `YOUR_PHONE_NUMBER_ID` and
  `YOUR_STAFF_WHATSAPP_NUMBER` in the URL/body, and set the HTTP Header Auth
  credential to `Authorization: Bearer <your Meta access token>`.

Click **Activate** on the workflow (top right). Open the Webhook node and
copy its **Production URL** — that's what goes into Insight Bot.

## 4. Point Insight Bot at it
In the Insight Bot admin panel (`/admin`), edit the tenant's config:
```json
"integrations": {
  "webhook": {
    "enabled": true,
    "url": "https://n8n.yourdomain.com/webhook/insight-bot-leads",
    "headers": { "<header name from step 3>": "<header value from step 3>" }
  }
}
```
Save & reload. Every booking and escalation lead now POSTs here instead of
(or alongside) the built-in email/WhatsApp notifiers.

## 5. Back these up
- `N8N_ENCRYPTION_KEY` from your `.env` — losing it makes every stored
  credential unreadable.
- The `n8n_data` Docker volume — holds your workflows and (encrypted)
  credentials. `docker compose exec n8n n8n export:workflow --all --output=/home/node/.n8n/backup.json`
  periodically, or snapshot the volume itself.

## If the JSON import has issues — build it manually instead
1. New workflow → add a **Webhook** node, POST, Header Auth (as above).
2. Add an **IF** node checking `{{$json.body.type}} == "booking"`.
3. On each branch, add a **Send Email** node with your SMTP credential.
4. Merge both branches into one **HTTP Request** node (POST to
   `https://graph.facebook.com/v20.0/<phone_number_id>/messages`, Header
   Auth with your Meta bearer token, JSON body per the WhatsApp Cloud API).
5. End with a **Respond to Webhook** node returning `{"ok": true}`.

This is the exact same shape as the JSON above — building it by hand in
n8n's editor is slower but guaranteed compatible with whatever version
you're running.
