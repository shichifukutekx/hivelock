import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { can as allowed, type Permission } from "../../../src/platform/permissions.ts";
import { api, space, type Me } from "./api.ts";

export const useMe = () => useQuery<Me>({ queryKey: ["me"], queryFn: () => api("/api/v1/me") });

/** The current workspace, its API path, and what this person's role may do. Hiding a button is a courtesy: the server still checks. */
export function useWorkspace() {
  const { workspaceId } = useParams();
  const me = useMe();
  const workspace = me.data?.workspaces.find((w) => w.id === workspaceId);
  return {
    id: workspaceId!,
    path: space(workspaceId!),
    workspace,
    role: workspace?.role,
    can: (permission: Permission) => allowed(workspace?.role, permission),
    link: (to = "") => `/w/${workspaceId}${to}`,
  };
}
