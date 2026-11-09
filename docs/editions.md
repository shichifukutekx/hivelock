# Editions

Hivelock comes in three editions. The server works out which one it is on every check, so a change needs no restart.

| | Community | Self-hosted licensed | Hosted |
|---|---|---|---|
| Runs on | Your server | Your server | Our cloud, with `HOSTED_MODE=true` |
| Needs | Nothing | A valid licence key | A paid plan |
| Cost | Free | Commercial licence | By plan |
| Limits | Below | None, except a seat limit if the key has one | By plan |

A self-hosted server with no licence key is Community, whether the paid package is installed or not. `HOSTED_MODE=true` needs the package: the server refuses to start without it, because the rules that keep customers apart are in it.

## Open source and the commercial licence

The Hivelock core is open source under the GNU Affero General Public License, version 3 only (AGPL-3.0-only). The core alone is the Community edition, free to run.

Single sign-on, hosted plans and billing, licence keys, the paid connectors, WhatsApp channels, email triggers, version compare and restore, and agent tests are in a separate paid package under a commercial licence. That package is not part of the AGPL code. A separate commercial licence for the core is also available for anyone who does not want the AGPL's terms.

The core has no key checking in it. Its limits are a plain statement of what Community includes, and anyone may change AGPL code, including them. How the core and the package fit together is in `extensions.md`.

## Community

Every limit is in one place, `COMMUNITY` in `src/platform/plans.ts`.

| Limit | Community |
|---|---|
| Workspaces | 1 |
| People, including open invitations | 5 |
| Agents you add, per workspace | 5 |
| Workflows, per workspace | 10 |
| Document storage, per workspace | 1 GB |
| Runs a month | No limit, because you pay for the server |

People and workspaces count across the whole server. Someone in two workspaces counts once.

**Included:** the visual builder, agents, chat, human approvals, schedules and signed webhooks, document search, any AI model including local and private addresses, mandatory two-step sign-in, the audit log, roles, and every template that uses included connectors.

**Connectors included:** `http`, `mcp`, `email`, `database`, `slack`, `teams`. All others are paid.

**Not included:** single sign-on, WhatsApp channels, email triggers, workflow version compare and restore, agent tests (the evals in observability), and the extra connectors. The last 10 versions of a workflow stay readable.

Security and AI model choice are never reduced. Two-step sign-in, approvals, audit, encryption, the network guard and the open model setup are the same in every edition.

## At a limit, or when a licence ends

Nothing is deleted, blocked or changed. Only adding more stops. A refusal is HTTP 402 with the code `edition_limit`, and its message names the edition and how to upgrade.

The table below is a server with the paid package and no valid key. With the package removed, the same data stays in the database untouched, but what needs the package stops: see `extensions.md`.

| What you already have | On Community |
|---|---|
| More workspaces, people, agents, workflows or storage than the limits | All stay, and keep working. You cannot add more until you are under the limit. Removing is always allowed. |
| Workflows and their schedules, webhooks and runs | Keep working |
| Email triggers | Keep checking their mailboxes. You cannot add one. |
| Single sign-on already set up | Keeps working, including *Require single sign-on*, so people with no password are not locked out and a workspace does not fall back to passwords. You cannot set up a new one, prove a domain or turn on the requirement. |
| Connections of a paid type | **Stay listed, but cannot run.** A workflow step using one fails with a message saying so, and an agent is told the same. Credentials stay stored and encrypted. The connection test is refused. |
| WhatsApp channels | Stay listed, but stop answering, because they run on a paid connection |
| Workflow versions | All stay stored. The last 10 can be read. A licence key brings back the rest, and compare and restore. |
| Agent tests | Saved tests and results stay readable. You cannot add or run tests. |

A template that needs a paid connector shows as needing an upgrade and cannot be installed. Templates that start from mail install, but need another way to start without a licence key.

## Licence keys

A licence key is read by the paid package, which checks it offline and needs no network call. Paste the key under **Settings, Edition and licence**, or set `HIVELOCK_LICENSE_KEY` for both the app and the worker. Only the platform administrator (`BOOTSTRAP_ADMIN_EMAIL`) sees that form. Everyone in a workspace can see the edition and usage.

A bad key, or one past its grace period, leaves the server on Community with a notice in Settings. After a key expires, everything stays on for 14 days, with a notice, and then the server shows Community. A seat limit counts people the way Community does, across the server.
