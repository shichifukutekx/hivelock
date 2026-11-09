/** Calls the platform API. The session lives in a secure cookie that scripts cannot read. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly body?: any) {
    super(message);
  }
}

export async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
    headers: options.body === undefined ? undefined : { "content-type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "same-origin",
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {}
  if (!response.ok) {
    throw new ApiError(data?.error ?? data?.message ?? "Something went wrong. Try again.", response.status, data?.code, data);
  }
  return data as T;
}

export interface Workspace { id: string; name: string; slug: string; role: string; ssoNeeded?: boolean; suspended?: boolean }
export interface Me { user: { id: string; email: string; name: string }; workspaces: Workspace[]; hosted: boolean; singleSignOn: boolean; canCreateWorkspaces: boolean; isPlatformAdmin: boolean; operatorRole?: string }

export const space = (workspaceId: string) => `/api/v1/workspaces/${workspaceId}`;

export const when = (value?: string | null) =>
  value ? new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "—";

export function ago(value?: string | null) {
  if (!value) return "—";
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

export function duration(start?: string | null, end?: string | null) {
  if (!start || !end) return "—";
  const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)} s` : `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** What a run or step cost. Small amounts keep their digits, because most runs cost less than a cent. */
export function cost(usd?: string | number | null, tokens?: string | number | null) {
  if (usd !== null && usd !== undefined) {
    const value = Number(usd);
    return `$${value >= 0.01 || value === 0 ? value.toFixed(2) : value.toFixed(4)}`;
  }
  return Number(tokens ?? 0) > 0 ? `${Number(tokens).toLocaleString()} tokens` : "—";
}

/** Whether an error's next step is on the Settings page, because it says so. */
export const pointsToSettings = (message?: string | null) => !!message && /\bSettings\b/.test(message);
