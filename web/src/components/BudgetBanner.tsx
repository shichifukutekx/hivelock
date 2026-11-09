import { useQuery } from "@tanstack/react-query";
import { Gauge } from "lucide-react";
import { Link } from "react-router-dom";
import { api } from "../lib/api.ts";
import { useWorkspace } from "../lib/workspace.ts";

/** From this share of the month's tokens on, everyone sees a warning, before agents stop rather than after. */
export const WARN_AT = 0.8;

/** Shown on every page once the month's model allowance is nearly or fully used. */
export function BudgetBanner() {
  const { path, workspace, link, can } = useWorkspace();
  const settings = useQuery<{ tokensUsedThisMonth: number; monthlyTokenLimit: number }>({
    queryKey: ["settings", path], queryFn: () => api(`${path}/settings`), enabled: !!workspace, refetchInterval: 60_000,
  });
  if (!settings.data) return null;
  const { tokensUsedThisMonth: used, monthlyTokenLimit: limit } = settings.data;
  const share = limit > 0 ? used / limit : 1;
  if (share < WARN_AT) return null;
  const reached = share >= 1;
  return (
    <div role="status" className={`enter-fade flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-4 py-2 text-[13px] ${reached ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"}`}>
      <Gauge size={15} className="shrink-0" />
      <p className="min-w-0 flex-1">
        <strong className="font-semibold">{reached ? "This month's AI allowance is used up." : `${Math.floor(share * 100)}% of this month's AI allowance is used.`}</strong>{" "}
        {reached ? "Agent steps and chats stop until next month or until the limit is raised." : "Agent steps and chats stop when it runs out."}
      </p>
      {can("members:manage") ? <Link to={link("/settings")} className="font-medium underline">Change the limit</Link> : <span>An admin can raise the limit.</span>}
    </div>
  );
}
