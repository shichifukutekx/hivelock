import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, Copy, KeyRound, LogIn, MailCheck, Save, Send, ShieldCheck, UserPlus } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Logo } from "../components/Logo.tsx";
import { Button, Field, Input, Notice, Spinner } from "../components/ui.tsx";
import { web } from "../lib/extensions.ts";
import { api, type ApiError } from "../lib/api.ts";
import { brand } from "../lib/brand.ts";

export function AuthCard({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <main className="brand-backdrop flex min-h-full items-center justify-center p-4">
      <div className="enter-page relative w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2 font-display text-[19px] font-semibold tracking-tight">
          <Logo size={30} className="text-accent" />
          {brand.name}
        </div>
        <div className="rounded-2xl border border-line bg-surface p-7 card-soft">
          <h1 className="text-[22px] leading-tight font-semibold tracking-tight">{title}</h1>
          {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
          <div className="mt-5">{children}</div>
        </div>
      </div>
    </main>
  );
}

/** Stays on this site, so a crafted link cannot send someone elsewhere after signing in. */
const safeNext = (params: URLSearchParams) => {
  const next = params.get("next") ?? "/";
  try {
    const url = new URL(next, location.origin);
    return next.startsWith("/") && url.origin === location.origin ? url.pathname + url.search : "/";
  } catch {
    return "/";
  }
};

/** An invitation link passes through sign-in, and sign-up needs its id. */
const invitationIn = (next: string) => next.match(/^\/invite\/([\w-]+)/)?.[1];

export function useSubmit() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = (work: () => Promise<void>) => async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (problem) {
      setError((problem as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit, clear: () => setError("") };
}

export function SignIn() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"password" | "code" | "backup">("password");
  const [alternate, setAlternate] = useState(false);
  const [lostDevice, setLostDevice] = useState(false);
  const { error, busy, submit, clear } = useSubmit();
  const added = web.signIn;
  const addedProblem = added?.problem?.(params) ?? "";

  const finish = async () => {
    await client.resetQueries();
    navigate(safeNext(params));
  };

  const [unconfirmed, setUnconfirmed] = useState("");
  const signIn = submit(async () => {
    setUnconfirmed("");
    try {
      const result = await api("/api/auth/sign-in/email", { body: { email, password } });
      if (result.twoFactorRedirect) setStep("code");
      else await finish();
    } catch (problem) {
      // The server has just mailed a confirmation link, so this is a next step rather than a failure.
      if ((problem as ApiError).code === "EMAIL_NOT_VERIFIED") return setUnconfirmed(email.trim());
      throw problem;
    }
  });
  const verify = submit(async () => {
    await api(step === "backup" ? "/api/auth/two-factor/verify-backup-code" : "/api/auth/two-factor/verify-totp", { body: { code } });
    if (step === "backup" && lostDevice) navigate("/setup-2fa?replace=1");
    else await finish();
  });

  if (step !== "password") {
    return (
      <AuthCard title="Two-step verification" description={step === "code" ? "Enter the six-digit code from your authenticator app." : "Enter one of your saved backup codes."}>
        <form onSubmit={verify} className="space-y-4">
          {error && <Notice>{error}</Notice>}
          <Field label={step === "code" ? "Code" : "Backup code"}>
            <Input value={code} onChange={(e) => setCode(e.target.value.trim())} inputMode={step === "code" ? "numeric" : "text"} autoComplete="one-time-code" autoFocus required />
          </Field>
          {step === "backup" && (
            <label className="flex items-center gap-2 text-[13px] text-muted">
              <input type="checkbox" checked={lostDevice} onChange={(e) => setLostDevice(e.target.checked)} /> I lost my authenticator. Replace it next.
            </label>
          )}
          <Button type="submit" variant="primary" busy={busy} className="w-full"><ShieldCheck size={14} /> Verify</Button>
          <button type="button" className="w-full text-[13px] text-muted hover:text-ink" onClick={() => { setCode(""); clear(); setStep(step === "code" ? "backup" : "code"); }}>
            {step === "code" ? "Use a backup code" : "Use my authenticator app"}
          </button>
        </form>
      </AuthCard>
    );
  }

  if (alternate && added) return <added.Form email={email} setEmail={setEmail} onBack={() => setAlternate(false)} />;

  return (
    <AuthCard title="Sign in" description="Welcome back.">
      <form onSubmit={signIn} className="space-y-4">
        {(error || addedProblem) && <Notice>{error || addedProblem}</Notice>}
        {unconfirmed && (
          <Notice tone="info" icon={MailCheck}>
            <p className="font-medium">Confirm your email address first.</p>
            <p className="mt-1">We have just sent a link to {unconfirmed}. Open it, then sign in here again. It can take a few minutes, so check spam too. Signing in again sends a new link.</p>
          </Notice>
        )}
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" autoFocus required /></Field>
        <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></Field>
        <Button type="submit" variant="primary" busy={busy} className="w-full"><LogIn size={14} /> Sign in</Button>
      </form>
      {added && <Button onClick={() => setAlternate(true)} className="mt-2 w-full"><added.icon size={14} /> {added.label}</Button>}
      <div className="mt-4 flex justify-between text-[13px] text-muted">
        <Link to="/forgot-password" className="hover:text-ink">Forgot password?</Link>
        <Link to={`/sign-up?next=${encodeURIComponent(safeNext(params))}`} className="hover:text-ink">Create account</Link>
      </div>
    </AuthCard>
  );
}

export function SignUp() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [checkEmail, setCheckEmail] = useState(false);
  const { error, busy, submit } = useSubmit();
  const config = useQuery({ queryKey: ["public-config"], queryFn: () => api("/api/public-config") });

  const signUp = submit(async () => {
    const result = await api("/api/auth/sign-up/email", { body: { name, email, password, invitationId: invitationIn(safeNext(params)) } });
    if (!result.token) return setCheckEmail(true);
    await client.resetQueries();
    navigate(`/setup-2fa?next=${encodeURIComponent(safeNext(params))}`);
  });

  if (checkEmail) return <AuthCard title="Check your email" description={`We sent a confirmation link to ${email}. Open it, then sign in.`}><Link to="/sign-in" className="inline-flex items-center gap-1 text-[13px] text-accent"><ArrowLeft size={13} /> Back to sign in</Link></AuthCard>;

  return (
    <AuthCard title="Create your account" description={config.data?.hosted ? "Confirm your email and set up two-step verification, then start a 14-day trial." : "Accounts are by invitation. Open your invitation link, and use the address it was sent to."}>
      <form onSubmit={signUp} className="space-y-4">
        {error && <Notice>{error}</Notice>}
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus required /></Field>
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></Field>
        <Field label="Password" help="At least 12 characters."><Input type="password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required /></Field>
        <Button type="submit" variant="primary" busy={busy} className="w-full"><UserPlus size={14} /> Create account</Button>
      </form>
      <p className="mt-4 text-[13px] text-muted">Already have an account? <Link to="/sign-in" className="text-accent">Sign in</Link></p>
    </AuthCard>
  );
}

export function SetupTwoFactor() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const [password, setPassword] = useState("");
  const replacing = params.get("replace") === "1";
  const [backupCode, setBackupCode] = useState("");
  const [replaced, setReplaced] = useState(false);
  const [setup, setSetup] = useState<{ uri: string; qr: string; backupCodes: string[] }>();
  const [copiedCodes, setCopiedCodes] = useState(false);
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const { error, busy, submit } = useSubmit();

  const begin = submit(async () => {
    if (replacing && !replaced) {
      await api("/api/v1/me/two-factor/replace", { body: { password, backupCode } });
      setReplaced(true);
    }
    const { totpURI, backupCodes } = await api("/api/auth/two-factor/enable", { body: { password } });
    // Drawn here, so the secret inside the code never goes to an outside service.
    setSetup({ uri: totpURI, qr: await QRCode.toDataURL(totpURI, { margin: 1, width: 180 }), backupCodes });
  });
  const verify = submit(async () => {
    await api("/api/auth/two-factor/verify-totp", { body: { code } });
    await client.resetQueries();
    navigate(safeNext(params));
  });

  if (!setup) {
    return (
      <AuthCard title={replacing ? "Replace your authenticator" : "Protect your account"} description={replacing ? "Enter your password and a backup code you have not used. Your old authenticator stops working." : "Two-step verification is required. Confirm your password to begin."}>
        <form onSubmit={begin} className="space-y-4">
          {error && <Notice>{error}</Notice>}
          <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required /></Field>
          {replacing && !replaced && <Field label="Backup code"><Input value={backupCode} onChange={(e) => setBackupCode(e.target.value.trim())} autoComplete="one-time-code" required /></Field>}
          <Button type="submit" variant="primary" busy={busy} className="w-full"><ShieldCheck size={14} /> Continue</Button>
        </form>
      </AuthCard>
    );
  }

  const secret = new URL(setup.uri).searchParams.get("secret");
  return (
    <AuthCard title="Scan this code" description="Use an authenticator app, then enter the code it shows.">
      <form onSubmit={verify} className="space-y-4">
        {error && <Notice>{error}</Notice>}
        <img src={setup.qr} alt="Two-step verification QR code" width={180} height={180} className="mx-auto rounded-lg bg-white" />
        <details className="text-[12px] text-muted">
          <summary className="cursor-pointer">Can't scan it?</summary>
          <code data-testid="totp-secret" className="mt-1 block font-mono break-all select-all">{secret}</code>
        </details>
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-[12px] font-medium text-muted">Backup codes. Each works once. Keep them somewhere safe.</p>
            <button type="button" className="inline-flex shrink-0 items-center gap-1 text-[12px] text-accent hover:underline" onClick={async () => { await navigator.clipboard.writeText(setup.backupCodes.join("\n")); setCopiedCodes(true); }}>{copiedCodes ? <Check size={12} /> : <Copy size={12} />} Copy</button>
          </div>
          <div className="grid grid-cols-2 gap-1 rounded-lg bg-sunken p-2 font-mono text-[12px]">
            {setup.backupCodes.map((backup) => <span key={backup}>{backup}</span>)}
          </div>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> I saved my backup codes
        </label>
        <Field label="Six-digit code"><Input value={code} onChange={(e) => setCode(e.target.value.trim())} inputMode="numeric" autoComplete="one-time-code" required /></Field>
        <Button type="submit" variant="primary" busy={busy} disabled={!saved} className="w-full"><ShieldCheck size={14} /> Turn on</Button>
      </form>
    </AuthCard>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const { error, busy, submit } = useSubmit();
  const send = submit(async () => {
    await api("/api/auth/request-password-reset", { body: { email, redirectTo: "/reset" } });
    setSent(true);
  });
  if (sent) return <AuthCard title="Check your email" description="If that address has an account, a reset link is on its way."><Link to="/sign-in" className="inline-flex items-center gap-1 text-[13px] text-accent"><ArrowLeft size={13} /> Back to sign in</Link></AuthCard>;
  return (
    <AuthCard title="Reset your password" description="We will email you a link to choose a new password.">
      <form onSubmit={send} className="space-y-4">
        {error && <Notice>{error}</Notice>}
        <Field label="Email"><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus required /></Field>
        <Button type="submit" variant="primary" busy={busy} className="w-full"><Send size={14} /> Send link</Button>
      </form>
    </AuthCard>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const { error, busy, submit } = useSubmit();
  const reset = submit(async () => {
    await api("/api/auth/reset-password", { body: { token: params.get("token"), newPassword: password } });
    navigate("/sign-in");
  });
  return (
    <AuthCard title="Choose a new password">
      <form onSubmit={reset} className="space-y-4">
        {error && <Notice>{error}</Notice>}
        <Field label="New password" help="At least 12 characters."><Input type="password" minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus required /></Field>
        <Button type="submit" variant="primary" busy={busy} className="w-full"><Save size={14} /> Save password</Button>
      </form>
    </AuthCard>
  );
}

export function InvitePage() {
  const { invitationId } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const invitation = useQuery({ queryKey: ["invitation", invitationId], queryFn: () => api(`/api/auth/organization/get-invitation?id=${encodeURIComponent(invitationId!)}`) });
  const { error, busy, submit } = useSubmit();
  const accept = submit(async () => {
    await api("/api/auth/organization/accept-invitation", { body: { invitationId } });
    await client.resetQueries();
    navigate(`/w/${invitation.data.organizationId}`);
  });
  useEffect(() => { document.title = `Invitation · ${brand.name}`; }, []);
  if (invitation.isLoading) return <Spinner />;
  if (invitation.isError) return <AuthCard title="This invitation is not available" description="It may have expired, or it may be for another address."><Link to="/" className="text-[13px] text-accent">Go home</Link></AuthCard>;
  return (
    <AuthCard title={`Join ${invitation.data.organizationName}`} description={`You were invited as ${invitation.data.role}.`}>
      <form onSubmit={accept} className="space-y-4">
        {error && <Notice>{error}</Notice>}
        <Button type="submit" variant="primary" busy={busy} className="w-full"><Check size={14} /> Accept invitation</Button>
      </form>
    </AuthCard>
  );
}
