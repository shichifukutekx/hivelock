import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "./api.ts";
import { useMe, useWorkspace } from "./workspace.ts";

const SALES = "sales@shichifukutekx.ae";

/** Undefined in hosted mode, which has plans instead, so no page there changes. */
export function useEdition() {
  const { path } = useWorkspace();
  const me = useMe();
  return useQuery({ queryKey: ["edition", path], queryFn: () => api(`${path}/edition`), enabled: me.data?.hosted === false });
}

/** Whether this feature is left out here. Hiding is a courtesy: the server still checks. */
export function useLocked(feature: string) {
  return !!useEdition().data?.lockedFeatures.some((item: any) => item.id === feature);
}

/** One plain line in place of a feature, so nothing just disappears. */
export const Locked = ({ children }: { children: ReactNode }) => (
  <p className="flex gap-2 text-[13px] text-muted"><Lock size={14} className="mt-[3px] shrink-0" /><span className="min-w-0">{children} Not part of Community. <a className="underline" href={`mailto:${SALES}`}>Contact sales</a> for a licence key.</span></p>
);
