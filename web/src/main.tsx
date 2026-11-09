import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, createRoutesFromElements, Navigate, Route, RouterProvider, useLocation } from "react-router-dom";
import "./app.css";
import { Spinner } from "./components/ui.tsx";
import { api } from "./lib/api.ts";
import { applyBrand } from "./lib/brand.ts";
import { loadWebExtension, web } from "./lib/extensions.ts";
import { lockedPages } from "./lib/paid-pages.tsx";
import { Shell } from "./components/Shell.tsx";
import { ForgotPassword, InvitePage, ResetPassword, SetupTwoFactor, SignIn, SignUp } from "./pages/Auth.tsx";
import { AgentChat } from "./pages/AgentChat.tsx";
import { Agents } from "./pages/Agents.tsx";
import { Approvals } from "./pages/Approvals.tsx";
import { Audit } from "./pages/Audit.tsx";
import { Builder } from "./pages/Builder.tsx";
import { Connections } from "./pages/Connections.tsx";
import { Dashboard } from "./pages/Dashboard.tsx";
import { Files } from "./pages/Files.tsx";
import { Memory } from "./pages/Memory.tsx";
import { Observability } from "./pages/Observability.tsx";
import { Trace } from "./pages/Trace.tsx";
import { RunDetail } from "./pages/RunDetail.tsx";
import { Runs } from "./pages/Runs.tsx";
import { Help } from "./pages/Help.tsx";
import { Settings } from "./pages/Settings.tsx";
import { TemplateDetail, Templates } from "./pages/Templates.tsx";
import { Home, NewWorkspace } from "./pages/Workspaces.tsx";
import { Workflows } from "./pages/Workflows.tsx";

const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 5_000 } } });

function Protected({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const session = useQuery({ queryKey: ["session"], queryFn: () => api("/api/auth/get-session") });
  const needsSecondStep = !!session.data?.user && !session.data.user.twoFactorEnabled && !web.trustsSession?.(session.data);
  // A person may have turned the second step off for their own account. The server says so, and checks it on every call.
  const choice = useQuery({ queryKey: ["two-factor"], queryFn: () => api("/api/v1/me/two-factor").catch(() => ({ optedOut: false })), enabled: needsSecondStep });
  if (session.isLoading || (needsSecondStep && choice.isLoading)) return <Spinner />;
  const next = encodeURIComponent(location.pathname + location.search);
  if (!session.data?.user) return <Navigate to={`/sign-in?next=${next}`} replace />;
  // An extension may vouch for a second step taken elsewhere. The server makes the same exception.
  if (needsSecondStep && !choice.data?.optedOut) return <Navigate to={`/setup-2fa?next=${next}`} replace />;
  return <>{children}</>;
}

await loadWebExtension();
// The standard look is always a working answer.
await web.loadBrand?.().then(applyBrand).catch(() => {});

// A data router, because warning before leaving unsaved work needs useBlocker.
const router = createBrowserRouter(createRoutesFromElements(
  <>
  <Route path="/sign-in" element={<SignIn />} />
  <Route path="/sign-up" element={<SignUp />} />
  <Route path="/forgot-password" element={<ForgotPassword />} />
  <Route path="/reset" element={<ResetPassword />} />
  <Route path="/setup-2fa" element={<SetupTwoFactor />} />
  <Route path="/invite/:invitationId" element={<Protected><InvitePage /></Protected>} />
  <Route path="/" element={<Protected><Home /></Protected>} />
  <Route path="/new-workspace" element={<Protected><NewWorkspace /></Protected>} />
  {web.appRoutes?.map(({ path, element }) => <Route key={path} path={path} element={<Protected>{element}</Protected>} />)}
  <Route path="/w/:workspaceId" element={<Protected><Shell /></Protected>}>
    <Route index element={<Dashboard />} />
    <Route path="templates" element={<Templates />} />
    <Route path="templates/:templateId" element={<TemplateDetail />} />
    <Route path="workflows" element={<Workflows />} />
    <Route path="workflows/:workflowId" element={<Builder />} />
    <Route path="runs" element={<Runs />} />
    <Route path="runs/:runId" element={<RunDetail />} />
    <Route path="approvals" element={<Approvals />} />
    <Route path="agents" element={<Agents />} />
    <Route path="agents/:agentName" element={<AgentChat />} />
    <Route path="files" element={<Files />} />
    <Route path="memory" element={<Memory />} />
    {[...lockedPages(), ...(web.routes ?? [])].map(({ path, element }) => <Route key={path} path={path} element={element} />)}
    <Route path="observability" element={<Observability />} />
    <Route path="traces/:traceId" element={<Trace />} />
    <Route path="connections" element={<Connections />} />
    <Route path="audit" element={<Audit />} />
    <Route path="settings" element={<Settings />} />
    <Route path="help" element={<Help />} />
  </Route>
  <Route path="*" element={<Navigate to="/" replace />} />
  </>,
));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
