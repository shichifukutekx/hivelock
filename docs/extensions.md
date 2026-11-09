# Extensions

Hivelock runs alone as the Community edition. Everything else reaches the core through one small interface, so the core builds, runs and passes its tests with no other package present. A server loads `ee/index.ts` if that file exists, and the browser build loads `ee/web/index.tsx` the same way. Nothing else in the core mentions a package.

- Server: `src/platform/extensions.ts`
- Web: `web/src/lib/extensions.ts`

The path is built at run time on the server, and is a `import.meta.glob` in the browser, so a missing package is not an error, and its code is not in the build.

## Server

An extension is an object. Every member is optional.

| Member | What it adds |
|---|---|
| `migrations` | A folder of `.sql` files, run after the core's in name order |
| `databaseFunctions` | Database functions the app role may call |
| `databaseRoles` | A login of the package's own for functions the app role must never reach. `migrate.ts` makes it with no rights but those functions, and takes them from the app role |
| `prepareDatabase` | Runs as the admin role at the end of every migration, to store what only the settings know |
| `close` | Frees what the package opened, as the server stops |
| `encryptedColumns` | Encrypted columns, so key rotation covers them |
| `queues`, `worker` | pg-boss queues and the job handlers for them |
| `routes` | Hono routes, added before the core's workflow routes so a specific path wins over a general one |
| `reservedPaths` | Paths the web app must not answer |
| `gates` | Permission gates, run on every workspace request whatever the role. A route can stay open past one with `breakGlassRoute` or `suspendedRoute`, and `readOnlyRoute` keeps one that only stops work open in a read-only workspace |
| `auth` | better-auth plugins, closed paths, session fields, and hooks on sign-in and sessions |
| `meFields` | Fields to add to what `/api/v1/me` says about the person |
| `edition` | Which edition this server is, and how to upgrade |
| `triggerKinds` | Kinds of workflow trigger beyond schedules and webhooks |
| `notifyContact` | Sends text to someone on the far end of a conversation from outside the app |
| `maintainWorkspace`, `maintainServer` | Nightly work |
| `hosted` | The multi-tenant rules, including how many steps and agent turns each workspace may run at once (`workLimit`) |
| `agentGate` | A release gate: starts a changed agent's tests and keeps live workflow steps off it until they pass. Without it, a change goes live at once |

A connector needs no member. A module that calls `registerConnector` when imported has added itself.

## Web

An extension is an object too, and every member is optional: `routes`, `navigation`, `appRoutes`, `appLinks`, `settingsSections`, `connectorIcons`, `signIn`, `trustsSession`, `workspaceGate`, `AgentTests`, `EmailTriggerForm` and `VersionActions`. A page the core names and has no code for shows what it is and how to get it. A route the extension gives for the same path replaces that.

## Rules

- **Security and model choice never move out of the core.** Two-step sign-in, approvals, audit, encryption, the network guard and the open model setup are in every edition.
- **Hosted mode fails closed.** `hostedPolicy()` throws when nothing supplies the `hosted` member. `loadEnv` and `createApp` both call it, so `HOSTED_MODE=true` with no package cannot start, whatever starts it.
- **Every program loads extensions before reading settings.** Forgetting to can only make a hosted server refuse to start.
- **A locked feature explains itself.** A paid route with no package behind it answers 402 with the code `edition_limit` and how to upgrade. `PAID_ROUTES` in `src/platform/app.ts` lists these.

## Migrations

`schema_migrations` records names, so a migration keeps its name when it moves. The order is fixed: all of the core's files by name, then each extension's. Two files with one name are refused, because one would never run.

To cut a released file in two, the part that moves keeps the old name, and the part that stays takes a new name and starts with:

```sql
-- replaces: 012_hosted_sso_billing.sql
```

A database that ran the old file counts as having both parts. One that began with the new part alone has no record of the old name, so the moved part still runs when the package arrives. The stay-behind part must not keep the old name, or that second case would skip the moved part.

A core migration must not depend on an extension's table. An extension's migration may depend on any of the core's.

## Removing a package from a server

Nothing is deleted: its tables stay, and putting the package back finds them where they were.

First, sign out every session a provider opened, as the admin role, while the server is stopped:

```sql
delete from session where "ssoProviderId" is not null;
```

Skipping this leaves one exact gap. Only the package reads that mark on a session. Take someone who has a password and two-step verification on their account, and who signed in through their provider. With the package gone, that session looks like an ordinary one. It counts as having passed two-step verification, though it never did. It reaches every workspace the person belongs to, not only the one their provider stood behind. If the person is the bootstrap administrator, it also counts as the platform administrator. This lasts until the session expires. Someone without two-step verification on their account is stopped at it instead.

While the package is away:

- Its features stop, including email triggers, which stop checking their mailboxes, and channels.
- Its connectors cannot run. Saved connections stay listed and say why.
- Single sign-on stops. A workspace that required it can be reached with a password again, and people with no password cannot sign in.
- Key rotation does not cover its tables. It reports them and keeps the rotation unverified, so the old key is not given up by mistake. Do not remove the old key until the package is back.
