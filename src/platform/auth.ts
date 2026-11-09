import { createHmac, timingSafeEqual } from "node:crypto";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { twoFactor, organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import type { Pool } from "pg";
import type { PlatformEnv } from "./env.ts";
import { recordAudit } from "./audit-log.ts";
import { extensions, hostedPolicy, productName } from "./extensions.ts";
import { createMailer, environmentMail, explainMailError } from "./mailer.ts";

const ac = createAccessControl(defaultStatements);
/**
 * Each takes only a password, or nothing, and a stolen password must not be able to remove the second step, read its secret or mint new backup codes.
 * Enrolling cannot replace a factor already in use, so a lost authenticator goes through /api/v1/me/two-factor/replace.
 */
export const TWO_FACTOR_CLOSED_PATHS = ["/two-factor/disable", "/two-factor/get-totp-uri", "/two-factor/generate-backup-codes", "/two-factor/send-otp", "/two-factor/verify-otp"];
const SESSION_HOURS = 8;

/**
 * Sign-up is closed. The bootstrap address may start the system, and anyone else needs a real invitation id,
 * which proves they received the invitation rather than just knowing who was invited.
 * Every refusal reads the same, so this cannot be used to learn who has been invited.
 *
 * Hosted sign-up is open, but stays closed to everyone else until the administrator's account exists.
 * So that account is always the first, nobody can squat on its address first, and nobody can register it afterwards.
 */
export async function assertMaySignUp(pool: Pool, env: PlatformEnv, email: string, invitationId?: string) {
  const address = email.trim().toLowerCase();
  if (env.HOSTED_MODE) {
    const admin = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
    const { rows: [{ exists }] } = await pool.query(`select exists (select 1 from "user" where lower(email) = $1) as exists`, [admin]);
    if (exists === (address === admin)) throw new APIError("FORBIDDEN", { message: "Sign-up is not available for this address." });
    return;
  }
  const { rows } = await pool.query<{ users: number; invited: boolean }>(
    `select (select count(*)::int from "user") as users,
            exists (select 1 from invitation
                    where id = $2 and lower(email) = $1 and status = 'pending' and "expiresAt" > now()) as invited`,
    [address, invitationId ?? ""],
  );
  const { users, invited } = rows[0]!;
  const isBootstrap = users === 0 && address === env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
  if (!isBootstrap && !invited) throw new APIError("FORBIDDEN", { message: "Sign-up is by invitation only." });
}

export interface Person {
  id: string;
  email: string;
  emailVerified?: boolean;
  sessionId?: string;
  /** Set by an extension on a session that reaches one workspace and nothing else. */
  scopedWorkspaceId?: string;
  /** Set by an extension on a session an outside identity provider opened, which had its second step there. */
  externalIdentity?: string;
}

export const SIGNUP_COOKIE = "hivelock_signup";
const signupProof = (env: PlatformEnv, userId: string) => createHmac("sha256", env.BETTER_AUTH_SECRET).update(`signup:${userId}`).digest("base64url");

/** Given to the browser that signed up. A verification link opened there is the same person, so their password stays. */
export const signupCookie = (env: PlatformEnv, userId: string) =>
  `${SIGNUP_COOKIE}=${signupProof(env, userId)}; Path=/api/auth/verify-email; Max-Age=${24 * 60 * 60}; HttpOnly; SameSite=Lax${env.PUBLIC_URL.startsWith("https://") ? "; Secure" : ""}`;

function hasSignupProof(env: PlatformEnv, userId: string, request?: Request) {
  const sent = request?.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${SIGNUP_COOKIE}=`))?.slice(SIGNUP_COOKIE.length + 1);
  const expected = Buffer.from(signupProof(env, userId));
  return !!sent && Buffer.byteLength(sent) === expected.length && timingSafeEqual(Buffer.from(sent), expected);
}

/**
 * Anyone can sign up with an address they do not hold, and the owner's click would then confirm the stranger's password. So when a link is opened
 * in another browser, an account nobody has used loses its password. On a hosted server the administrator's account goes even if it has been used,
 * because anyone could have taken that address and signed in before mail was set up, and it has no powers until it is confirmed. Returns true if the password went.
 */
async function dropUnprovedPassword(pool: Pool, env: PlatformEnv, user: { id: string; email: string }) {
  const { rows: [row] } = await pool.query(
    `select exists (select 1 from account where "userId" = $1 and "providerId" = 'credential') as has_password,
            exists (select 1 from member where "userId" = $1) or exists (select 1 from session where "userId" = $1) as used`,
    [user.id],
  );
  const hostedAdministrator = env.HOSTED_MODE && user.email.trim().toLowerCase() === env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
  if (!row.has_password || (row.used && !hostedAdministrator)) return false;
  await pool.query(`delete from account where "userId" = $1 and "providerId" = 'credential'`, [user.id]);
  await pool.query(`delete from session where "userId" = $1`, [user.id]);
  await pool.query(`delete from "twoFactor" where "userId" = $1`, [user.id]);
  await pool.query(`update "user" set "twoFactorEnabled" = false where id = $1`, [user.id]);
  return true;
}

/** Names people choose are repeated in mail this server sends, so anything that could carry a link or break a line is left out. */
function nameForMail(name: string, fallback: string) {
  const plain = name.normalize("NFKC");
  const carriesLink = /https?:|www[.\u3002]|\/\/|@|[\p{L}\p{N}-][.\u3002]\p{L}{2,}/iu.test(plain);
  return carriesLink || /\p{C}/u.test(plain) || !plain.trim() || plain.length > 80 ? fallback : plain;
}

/** Every library path can be spelled several ways, and this reads them all as one. */
export const plainPath = (path: string) => decodeURI(path.replace(/%(?![0-9a-f]{2})/gi, "%25")).replace(/%2f/gi, "/").toLowerCase().replace(/\/+$/, "");

/**
 * Server-wide settings belong to this person. An address is only a claim until it is proved, and whoever controls a workspace's identity provider
 * controls what it says, so a hosted server asks for a verified address and no session from any provider counts.
 */
export const isPlatformAdmin = (env: PlatformEnv, person: Person) =>
  person.email.trim().toLowerCase() === env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase() && !person.scopedWorkspaceId && !person.externalIdentity && (!env.HOSTED_MODE || person.emailVerified === true);

/**
 * Self-hosted, only the administrator opens workspaces, so an invited person cannot make themselves an owner.
 * Hosted, anyone may, once their address is verified and two-step verification is on.
 */
export async function mayCreateWorkspaces(pool: Pool, env: PlatformEnv, person: Person) {
  if (!env.HOSTED_MODE) return isPlatformAdmin(env, person);
  if (person.scopedWorkspaceId) return false;
  const { rows: [row] } = await pool.query(
    `select u."emailVerified" as verified, u."twoFactorEnabled" as two_factor,
            (select count(*)::int from member m where m."userId" = u.id and m.role = 'owner') as owned
     from "user" u where u.id = $1`,
    [person.id],
  );
  return !!row?.verified && !!row.two_factor && row.owned < hostedPolicy().maxOwnedWorkspaces;
}

/**
 * `mailConfigured` is read once, because better-auth fixes email verification at start.
 * Sending looks up its settings each time, so these functions always exist.
 */
export function createAuth(pool: Pool, env: PlatformEnv, { mailConfigured = environmentMail(env) }: { mailConfigured?: boolean } = {}) {
  const mail = createMailer(pool, env);
  const additions = extensions().flatMap(({ auth }) => (auth ? [auth] : []));
  let sendPasswordMail = async (_email: string) => {};
  // An error here could show a caller which addresses have accounts, so it goes to the log, in words that quote no server reply.
  const mailQuietly = async (event: string, message: Parameters<typeof mail>[0]) => {
    try {
      await mail(message);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event, message: explainMailError(error) }));
    }
  };
  const auth = betterAuth({
    appName: "Hivelock",
    baseURL: env.PUBLIC_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: pool,
    disabledPaths: [...additions.flatMap((item) => item.closedPaths ?? []), ...TWO_FACTOR_CLOSED_PATHS],
    // Asked on each request, so an extension can trust an origin for the length of one request and no longer.
    trustedOrigins: async () => [env.PUBLIC_URL, ...additions.flatMap((item) => item.trustedOrigins?.() ?? [])],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      // Proving an address needs mail, so these turn on at the first start after mail is set up.
      requireEmailVerification: mailConfigured,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 60,
      sendResetPassword: async ({ user, url }) => mailQuietly("password_reset_mail_failed", { to: user.email, subject: `Reset your ${await productName(pool)} password`, text: `Use this link within an hour to reset your password:\n\n${url}\n\nIf you did not ask for this, ignore this email.` }),
    },
    emailVerification: {
      sendOnSignUp: mailConfigured,
      // Accounts made before mail was set up are unconfirmed, and this is how they get back in.
      sendOnSignIn: mailConfigured,
      sendVerificationEmail: async ({ user, url }) => mailQuietly("verification_mail_failed", { to: user.email, subject: "Confirm your email address", text: `Open this link to confirm your address:\n\n${url}` }),
      // Runs before the address counts as confirmed, so a failure here leaves the account unconfirmed.
      beforeEmailVerification: async (user, request) => {
        if (hasSignupProof(env, user.id, request)) return;
        if (await dropUnprovedPassword(pool, env, user)) await sendPasswordMail(user.email);
      },
    },
    // The app never uses a provider's tokens, but the library stores them.
    account: { encryptOAuthTokens: true },
    session: {
      expiresIn: SESSION_HOURS * 60 * 60,
      updateAge: 60 * 60,
      additionalFields: Object.assign({}, ...additions.map((item) => item.sessionFields ?? {})),
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 60, max: 5 },
        "/two-factor/*": { window: 60, max: 5 },
        "/request-password-reset": { window: 60, max: 3 },
        "/reset-password": { window: 60, max: 5 },
        "/send-verification-email": { window: 60, max: 3 },
        ...Object.assign({}, ...additions.map((item) => item.rateLimits ?? {})),
      },
    },
    advanced: {
      useSecureCookies: env.PUBLIC_URL.startsWith("https://"),
      // Only the reverse proxy sets this. Clients can forge x-forwarded-for to dodge rate limits.
      ipAddress: { ipAddressHeaders: ["x-real-ip"] },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => ({ data: Object.assign({ ...session }, ...additions.map((item) => item.sessionCreating?.(session) ?? {})) }),
          after: async (session) => {
            await recordAudit(pool, { action: "auth.signed_in", actorId: session.userId, ip: session.ipAddress ?? undefined });
            for (const item of additions) await item.sessionCreated?.(pool, session);
          },
        },
      },
    },
    plugins: [
      twoFactor({ issuer: "Hivelock", trustDeviceMaxAge: 60 }),
      // Typed as nothing, so the library's types describe the core alone.
      ...(additions.flatMap((item) => item.plugins?.(pool, env) ?? []) as []),
      organization({
        ac,
        creatorRole: "owner",
        // Deleting goes through the workspace's own route, which keeps the data for the stated time.
        disableOrganizationDeletion: true,
        allowUserToCreateOrganization: (user) => mayCreateWorkspaces(pool, env, user),
        requireEmailVerificationOnInvitation: mailConfigured,
        // A failure must not undo the invitation: the page shows its link to pass on by hand.
        sendInvitationEmail: async ({ email, inviter, organization: workspace, role, id }) => mailQuietly("invitation_mail_failed", {
          to: email,
          subject: `Join ${nameForMail(workspace.name, "a workspace")} on ${await productName(pool)}`,
          text: `${nameForMail(inviter.user.name, "A teammate")} invited you to ${nameForMail(workspace.name, "a workspace")} as ${role}.\n\nOpen this link to join:\n\n${env.PUBLIC_URL}/invite/${id}`,
        }),
        organizationHooks: {
          afterCreateOrganization: async ({ organization: workspace, user }) => {
            for (const item of additions) await item.workspaceCreated?.(pool, env, workspace.id);
            await recordAudit(pool, { workspaceId: workspace.id, actorId: user.id, action: "workspace.created" });
          },
          afterAddMember: async ({ member, user, organization: workspace }) => {
            await recordAudit(pool, { workspaceId: workspace.id, actorId: user.id, action: "member.added", targetType: "member", targetId: member.id, details: { role: member.role } });
          },
          afterRemoveMember: async ({ member, user, organization: workspace }) => {
            await recordAudit(pool, { workspaceId: workspace.id, actorId: user.id, action: "member.removed", targetType: "member", targetId: member.id, details: { role: member.role } });
          },
          afterUpdateMemberRole: async ({ member, previousRole, user, organization: workspace }) => {
            await recordAudit(pool, { workspaceId: workspace.id, actorId: user.id, action: "member.role_changed", targetType: "member", targetId: member.id, details: { from: previousRole, to: member.role } });
          },
          afterCreateInvitation: async ({ invitation, inviter, organization: workspace }) => {
            await recordAudit(pool, { workspaceId: workspace.id, actorId: inviter.userId, action: "member.invited", targetType: "invitation", targetId: invitation.id, details: { role: invitation.role } });
          },
        },
        roles: { owner: ownerAc, admin: adminAc, builder: memberAc, operator: memberAc, viewer: memberAc },
      }),
    ],
  });
  sendPasswordMail = async (email) => {
    await auth.api.requestPasswordReset({ body: { email, redirectTo: "/reset" } });
  };
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;
