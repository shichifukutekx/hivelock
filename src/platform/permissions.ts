export const ROLES = ["owner", "admin", "builder", "operator", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "workspace:delete"
  | "billing:manage"
  | "sso:manage"
  | "members:manage"
  | "secrets:write"
  | "secrets:list"
  | "connections:write"
  | "connections:list"
  | "audit:read"
  | "agents:write"
  | "workflows:write"
  | "runs:start"
  | "runs:approve"
  | "content:read";

const operator: Permission[] = ["runs:start", "runs:approve", "content:read"];
const builder: Permission[] = [...operator, "agents:write", "workflows:write", "secrets:list", "connections:list"];
const admin: Permission[] = [...builder, "members:manage", "secrets:write", "connections:write", "audit:read"];

const grants: Record<Role, Permission[]> = {
  owner: [...admin, "workspace:delete", "billing:manage", "sso:manage"],
  admin,
  builder,
  operator,
  viewer: ["content:read"],
};

/** Unknown roles get nothing. */
export const can = (role: string | undefined, permission: Permission): boolean =>
  (ROLES as readonly string[]).includes(role ?? "") && grants[role as Role].includes(permission);
