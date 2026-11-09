# Hivelock developer guide

The detailed reference for running and developing Hivelock. For an overview, see the [README](../README.md).

## Set up

Needs Node 22 or newer.

```bash
npm install
cp .env.example .env
```

Set `LLM_API_KEY` in `.env` to your key from build.nvidia.com, then test the candidate models with it:

```bash
npm run check-models
```

## Run

### Web UI

```bash
npm run ui
```

Open http://127.0.0.1:4310. Pick an agent, send a request, watch each step, and approve or decline actions on the page. It only runs on your own computer because it has no login yet.

### Terminal

```bash
npm run agent -- document-assistant "How many days of leave do we get?"
npm run agent -- document-assistant "Summarize the leave policy and save a report"
```

The agent can only read `data/documents`. Saving a report asks for your approval in the terminal.

**Everything the agent reads is sent to the model provider, so don't add confidential files while using an external API. NVIDIA's free access is for testing, not production.**

## RFQ checker

`rfq-checker` reads a valve RFQ and reports whether it is ready to quote. The model extracts the line items, then ordinary code in `src/rfq/rules.ts` does the checks, so RFQ text cannot talk its way past them. It can draft questions for the customer, but sends nothing.

Paste an RFQ into the UI, attach a file with **Attach RFQ**, or put a file in `data/rfqs`. It reads PDF, Excel (.xlsx), CSV and text files up to 15 MB. Scanned PDFs and old .xls files are not supported yet. Uploaded files stay in `data/rfqs` until you delete them.

The field lists and limits in `rules.ts` are a starter set, and a sales engineer should confirm them.

To measure accuracy on the 22 made-up test RFQs (this uses about 10 minutes of free model calls):

```bash
KIMI_API_KEY= npm run eval:rfq
```

Expected answers are in `eval/rfq-cases.json`. To score the same RFQs as PDF or Excel files:

```bash
npm run eval:files
KIMI_API_KEY= EVAL_FORMAT=pdf npm run eval:rfq
KIMI_API_KEY= EVAL_FORMAT=xlsx npm run eval:rfq
```

## Check

```bash
npm test
npm run typecheck
```

Tests use a local stand-in for the provider, so they need no key and send no data anywhere.

## Add an agent

1. Copy `src/agents/document-assistant.ts` and change its model role, instructions, tools and limits.
2. Register it in `src/agents/index.ts`.
3. List any tool that changes something in `requiresApproval`.

New tools go in an MCP server under `src/mcp/`. Runs are logged to `logs/audit.jsonl`.

## Change models or provider

Models are set per role in `.env`: `main` for reasoning and tool use, `fast` for simple high-volume work, and `coding` for writing code. `LLM_MODEL_FALLBACK` is used when a model fails, then Kimi if `KIMI_API_KEY` is set. Agents can also use the `kimi` role to try Kimi first. Kimi uses paid credits, and `logs/audit.jsonl` shows which model answered each call.

To change provider, edit `LLM_BASE_URL`, `LLM_API_KEY` and the model lines. No code changes are needed.

## Orchestration

The harness is `src/runtime.ts` and `src/tools.ts`. Every agent runs through it, with the same tool allow-list, approvals, step and token limits, and audit log.

- `orchestrator` plans a request and hands one task at a time to other agents with `delegate`. Helpers see only the task they are given. Managing agents cannot be given work, so agents cannot loop.
- `agent-builder` designs a new agent with `create_agent`. A person approves each one, and it is saved to `data/agents/<name>.json`.
- `src/agents/registry.ts` sets what a created agent can have. It can only use tools from `toolCatalog`, so it can never delegate or create agents. Its limits, approvals and safety rules are set by code, and they are applied again every time the file loads. Delete the JSON file to remove an agent.
- The Flow panel in the UI draws each run live. Click a node to see its input, output, model and time. It shows runs; it is not a drag-and-drop workflow editor.

## Platform foundation

The multi-user API runs separately from the local UI, on port 4320:

```bash
npm run db:migrate
npm run platform
```

- `src/platform/env.ts` checks settings at startup and refuses unsafe ones.
- `src/platform/auth.ts` handles accounts, mandatory two-step verification and workspaces. Sign-up is closed: `BOOTSTRAP_ADMIN_EMAIL` creates the first account and is the only one who can open workspaces. Everyone else needs an invitation link, because sign-up checks the invitation id, not just the address.
- `src/platform/permissions.ts` defines the roles: owner, admin, builder, operator and viewer.
- `src/platform/secrets.ts` encrypts secrets with AES-256-GCM, using a separate key for each workspace. No route returns a secret's value. Back up `SECRETS_MASTER_KEY`: without it, stored secrets cannot be read.
- `src/platform/migrations/` holds the schema. Postgres row-level security keeps workspaces apart, and the audit log is append-only and hash-chained.
- The app connects with a limited database role (`DATABASE_URL`). Only migrations and key rotation use `DATABASE_ADMIN_URL`, and the app starts without it.

In production, run behind a reverse proxy that sets `x-real-ip`, because rate limiting and audit entries depend on it.

## Workflow engine

A workflow is a graph of steps saved as JSON. The API and the worker are separate processes, and more workers can run at once:

```bash
npm run platform
npm run worker
```

- `src/platform/engine/nodes.ts` holds the step types: start, agent, condition and approval. Add new ones with `registerNodeType`.
- `src/platform/engine/engine.ts` runs them. Each step is a durable job in PostgreSQL through pg-boss, saved in the same transaction as the run's progress. A run keeps its own copy of the workflow.
- A failed step gets three attempts. A worker that dies is noticed in about two minutes, and another worker takes over. Connector actions that change data are protected from repeats; a custom step type must look after this itself.
- An agent inside a workflow cannot use a tool that needs approval, because nobody is watching. Put an approval step before it.
- Every save keeps a numbered version with who saved it, when, and an optional note. The Builder's History panel lists, shows and compares them, and restoring saves a new version. The latest 100 versions of each workflow are kept; older ones go overnight unless a run in progress used them. A run always keeps its own copy.
- Email triggers watch one folder of an email connection over IMAP, every 1 to 60 minutes. Each new message starts one run, up to 20 per check, with `input.from`, `input.subject`, `input.text` and `input.attachments`. The mailbox is opened read-only. Only mail that arrives while the workflow is live counts, and mail from the mailbox's own address is ignored. Sender filters narrow mail down but do not prove who sent it, because a sender can be forged. Mail is run input and nothing else: it cannot choose a workflow or fill a template.
- Webhooks use `POST /hooks/<trigger id>` with `x-webhook-timestamp` (Unix seconds) and `x-webhook-signature`, the hex HMAC-SHA256 of `<timestamp>.<body>`. Calls older than five minutes and repeated calls are refused. The signing secret is shown once.
- Schedules use five-field cron with a time zone.
- Confidential mode is on by default for each workspace, and it stops any step reaching NVIDIA models. Kimi must be available, or the step fails.

### Pause all

Pause all is an emergency stop for one workspace. Anyone who can approve can press it, only someone who can manage members can resume, and both work in a read-only workspace, as does cancelling a run. Nothing is deleted.

- A manual run, a chat message, an agent test and a request to index a file are refused with 409 and the code `workspace_paused`.
- A step already queued is held, and carries on after Resume.
- A schedule that fires is skipped. A webhook is refused with 409 and leaves no failed run and no alert, and the same delivery can be sent again after Resume.
- A chat turn queued before the pause does not wait for Resume. It ends with a message saying so, and the person sends it again.
- A channel message gets no reply, because a reply would go out through the customer's own account, and it is not answered later. The sender is told nothing.
- An uploaded file is kept, and indexing it waits for Resume. A file being indexed stops at its next batch and starts again.
- An agent test run stops before its next test, keeps what finished, and ends as `stopped`.
- An agent already running can still think and read. Every action that needed a person's approval is checked again just before it runs, and is refused while paused, whichever tool it is.
- Mail triggers pause, and their mail waits in the mailbox.

## Connectors

A connector is one file that calls `registerConnector`, plus a line in `index.ts`. The six in `src/platform/connectors/` are the core's, and a package can add more (see `extensions.md`). It describes the credentials it needs and its actions. Each action says if it changes data.

Included: HTTP API, email (SMTP and IMAP), PostgreSQL and MySQL, Slack, Microsoft Teams, Telegram, Discord, Twilio SMS, Amazon S3, Google Drive, Google Sheets, OneDrive, Microsoft 365 (Outlook mail and SharePoint files), Notion, Airtable, HubSpot, Salesforce, Zendesk, Jira, GitHub, GitLab, Linear, Shopify, Stripe (read-only) and custom MCP servers.

- Credentials are encrypted per connection, and no route returns them. Creating a connection needs an admin; builders can use one in a workflow.
- All outbound HTTP goes through `src/platform/net/safe-fetch.ts`, which blocks private addresses, including through redirects and DNS, and stops credentials leaving their origin. Add internal hosts to `ALLOWED_PRIVATE_HOSTS`; workspaces cannot change this.
- An action that changes data runs at most once on our side: if it is unclear whether it got through, the step fails and says so, and it is never repeated on a guess. The one exception is an agent step with MCP tools, where a tool can repeat if the step restarts after a worker crash.
- Database connections are read-only unless `allowWrites` is on. Set `allowedRecipientDomains` on email connections, so a manipulated agent cannot mail data elsewhere. `allowedPrefixes` does the same for Twilio. Placeholders are refused in SOQL, JQL and Airtable formulas as they are in SQL, and Google Sheets stores values as written, so outside text cannot become a formula.
- MCP: add the URL, call `tools/refresh`, review, then turn tools on one at a time. New and changed tools stay off, and each call checks the tool still matches what was reviewed.
- An agent step gets the tools of its agent. Anything needing approval is refused in a step, because nobody is watching. Put an approval step before it instead.

The platform's own mail sends invitations, email verification and password reset. The platform administrator (`BOOTSTRAP_ADMIN_EMAIL`) sets it up under Settings, and `SMTP_URL` and `MAIL_FROM` are the fallback when nothing is saved there. Saved settings apply to the next message, but turning on email verification takes a restart, because it is fixed when the server starts.

After that restart, an account that has not confirmed its address needs a confirmation link to sign in, and that includes the first administrator's. Send a test email before restarting. If mail then breaks and you are locked out, an operator can confirm the account in the database: `update "user" set "emailVerified" = true where email = '...'`.

## Custom agents

The platform is general purpose: an agent is whatever its instructions and capabilities make it. RFQ checking is one example, kept in the local app only.

- Describe an agent in plain words and the system drafts it, or start blank. A person reviews everything before it is saved.
- An agent can use workspace files, any action on a workspace connection, and reviewed MCP tools. Credentials stay with the platform, so the model can use an account without seeing it.
- Anything that changes data asks a person first in chat. In a workflow nobody is watching, so it is refused.
- Chat with an agent from its page, or add it to a workflow. Agents can also run on schedules and webhooks through workflows.
- A chat turn is not retried after a worker dies, because its tools may already have acted. The conversation can continue with a new message.

## Observability

Every model and tool call in a run, chat or test becomes a span with its time, tokens, status and a risk score. Spans hold measurements only, never prompts or results.

- The Observability page shows usage, speed, errors, per-agent and per-model tables, and risky tool calls. Each run and chat links to its trace.
- `MODEL_PRICES` turns tokens into cost. Without prices, cost shows as unknown rather than a guess.
- `OTEL_EXPORTER_OTLP_ENDPOINT` sends spans to any OpenTelemetry collector, such as Grafana Tempo or Langfuse.
- `METRICS_TOKEN` turns on `/metrics` for Prometheus, and `ALERT_WEBHOOK_URL` gets a message when a run fails. `ERROR_REPORTING_DSN` sends errors to a Sentry-compatible service. See `docs/monitoring.md`.
- A metric label must come from a short fixed list. Never put a workspace, a person or an id in one.
- New work goes through `admit` in `src/platform/engine/fair-queue.ts`, so a workspace's limit holds. See `docs/high-availability.md`.
- Risk scores inform people. They do not block anything; approvals do that.

## Guardrails, memory, skills and tests

- Credentials are removed from tool results before the model sees them, and from answers. Personal data removal is a workspace setting. These are pattern checks, so they catch common formats, not everything.
- Injection attempts in chat messages are flagged in the trace. Wording varies, so this is a warning sign, not a defence.
- An agent with memory saves a note only after a person approves it, so a poisoned document cannot plant lasting instructions. Notes are encrypted and come back marked as data.
- Skills are reusable instructions, shared by any agent in a workspace.
- Tests send a message and check the answer by fixed rules, so a model never grades itself. Actions needing approval are refused during tests.

## AI models

Providers are set up per workspace under **Settings → AI models**, not in `.env`. Pick a preset or paste any OpenAI-compatible address, press **Find models**, choose models for each role, then **Test**. Providers are tried in the order shown, so the next one takes over if the first fails.

- Keys are encrypted and never shown again. A saved key only goes to its own address.
- **Any model server:** add any OpenAI-compatible address under Settings, with or without a key. On a self-hosted server this includes local and private addresses, such as Ollama or LM Studio, with no server setting. Cloud metadata addresses stay refused.
- **Confidential mode** uses only providers a person has cleared for confidential work.
- A workspace with no providers uses the server's `LLM_*` settings. **Import from server settings** moves them into encrypted settings, after which those lines can be removed from `.env`.

## Document search

Files uploaded to a workspace are split into passages and indexed automatically. Turn on **Search this workspace's documents** for an agent and it gets a `search_knowledge` tool, and names the file it used.

- Keyword search always works and needs no AI. Add an **embedding model** to a provider and search also finds meaning, through `pgvector`.
- Passages are encrypted, but the keyword index holds their individual words, because searching needs them. A database leak would reveal which words appear, not the readable text.
- Confidential mode applies: passages only go to cleared providers for embedding.

## Live streaming

Chat replies appear as they are written, from worker to browser through Postgres notifications, so this works across servers. Secrets are removed before text leaves, and the last part of the text is held back until it is safe. A workspace that removes personal data does not stream, because that needs the finished answer. Live text passes through Postgres notifications in the clear for a moment and is not stored there.

## WhatsApp

Agents can answer on WhatsApp through Meta's official Cloud API.

1. Create a Meta app with WhatsApp, and add a **WhatsApp** connection with its token, phone number ID, app secret and any long verify token.
2. Under **Channels**, choose that connection and an agent, and list the numbers allowed to use it. The list starts empty, so nobody can reach the agent until you add them.
3. Paste the channel's webhook address and verify token into Meta's webhook settings, and subscribe to `messages`.

Meta must reach the webhook, so this needs a public HTTPS address. Every message is checked against the app secret. Numbers not on the list get no reply. Actions needing approval wait for a person in the app, and cannot be approved from WhatsApp.

## Single sign-on

Owners connect their own identity provider under Settings, over OpenID Connect. This is in the paid package, with its own setup guide.

## Editions

A self-hosted server with no licence key runs the Community edition. The paid package and a valid key unlock the Self-hosted Licensed edition, and the package with `HOSTED_MODE=true` runs the hosted plans. See `editions.md`.

## Extensions

Everything optional reaches the core through one interface, `src/platform/extensions.ts` on the server and `web/src/lib/extensions.ts` in the browser. See `extensions.md`.

## Hosted mode

`HOSTED_MODE=true` turns on the multi-tenant cloud version: open sign-up, plans, billing and stricter rules. Without it, nothing changes. It needs the paid package, and the server refuses to start without it, because the rules that keep customers apart are there. These are off in hosted mode, because they rely on one trusted operator:

- Internal hosts, through `ALLOWED_PRIVATE_HOSTS` and `ALLOWED_MODEL_HOSTS`, and connector address overrides. The server will not start with them.
- The server's own model keys. Each customer adds their own, and the fallback in `workspaceModels` and the import route are off.
- Local file tools, which run as a process on the server's disk. Agents and templates that use them are refused. Document search still works.
- The older `src/ui` app and the command line.
- The local log file `AUDIT_LOG`, which would mix every customer's prompts.

## Web app

A React app in `web/`, served by the API on one address so the strict content policy stays on. Fonts, icons and the 2FA QR code are all local.

```bash
npm run db:migrate
npm run web:build
npm run platform
npm run worker
```

Open http://localhost:4320. The first account must use `BOOTSTRAP_ADMIN_EMAIL`. Use `npm run web:dev` for live reload on port 5173.

`scripts/e2e.sh` runs everything against a throwaway database on port 4330, for browser testing. It recreates that database each time.

## Operating it

- **Containers:** copy `.env.production.example` to `.env.production` and `.env.migrate.example` to `.env.migrate`, then run `docker compose --env-file .env.production --env-file .env.migrate up -d --build`. The superuser's details stay in `.env.migrate`, which only the database and the migrate step see. Caddy handles TLS and sets `x-real-ip`. Raise `deploy.replicas` on `worker` to do more work at once.
- **Backups:** `scripts/backup.sh` writes an encrypted dump; run it from cron. `scripts/restore.sh` restores into an empty database. Keep `BACKUP_PASSPHRASE` and `SECRETS_MASTER_KEY` apart from the backups: without the key, secrets and run data cannot be read. Also back up the `workspace-files` volume.
- **Upgrades:** `scripts/upgrade.sh` backs up, migrates and checks `/ready`, and stops at the first failure. See `docs/upgrades.md`.
- **Key rotation:** `npm run keys:rotate` moves everything to a new `SECRETS_MASTER_KEY`. See `docs/key-rotation.md`.
- **Lists:** list endpoints take `limit` and `offset` and answer with `total`. `src/platform/paging.ts` reads them, caps a page at 200 rows, and keeps sort columns to a named list. `DataTable` pages rows it was given. Pass `table` and `total` to let the server page, as Runs does. Search only columns the database can read, because sealed data stays sealed. `GET /audit` walks the whole chain unless `verify=false` is sent, so the page asks once and then turns pages without it.
- **Limits:** each workspace has a monthly token allowance and a run retention period under Settings. One agent step can go past the allowance before it stops. Rate limits are in `src/platform/rate-limit.ts`.
- **Run data** (inputs, outputs, activity and errors) is encrypted per workspace. Workflow definitions are not, so do not put secrets or customer data in a step's text.
- **Audit log:** the page shows the newest hash. Save it outside the platform regularly, because anyone with full database access could otherwise rewrite the chain.
- **Load check:** `npx tsx scripts/load-test.ts 300 3` measures throughput against a throwaway database.

### Before calling this production ready

- A professional penetration test. The review so far was automated, and it was not a substitute.
- A first real run of the Docker files, which have not been run.
- Monitoring and alerts, off-site backups, and a tested restore on the real server.
- Signed data terms from any provider that will see real documents.

## Licence

The Hivelock core is open source under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). See `../LICENSE`.

A separate commercial licence is available, and the paid package is under one. A licence key is a commercial agreement that unlocks the paid editions and comes with support. To ask about one, write to sales@shichifukutekx.ae. `editions.md` explains how the two fit together.
