export const canRetry = (status: string) => status === "failed" || status === "cancelled";
