/**
 * Turns a service's refusal or a network failure into a sentence a person can act on.
 * The service's own words, when given, follow as details, because they are sometimes the only clue.
 */

const firstSentence = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

export function serviceProblem(service: string, status: number, detail?: string) {
  const said = detail?.trim() ? ` Details: ${firstSentence(detail)}` : "";
  if (status === 401 || status === 403) return `${service} did not accept the key or password. Check it is correct and still active.${said}`;
  if (status === 404) return `${service} could not find that. Check the address or name.${said}`;
  if (status === 408 || status === 504) return `${service} took too long to answer. Try again in a moment.`;
  if (status === 429) return `${service} is limiting requests right now. Wait a minute and try again.`;
  if (status === 402) return `${service} refused this because of the account's billing or credit.${said}`;
  if (status >= 500) return `${service} is having trouble right now. Try again later.`;
  if (status === 400 || status === 422) return `${service} could not accept this request.${said}`;
  return `${service} could not complete the request.${said}`;
}

/** A thrown error from a network call, in plain words. */
export function plainError(error: unknown, service = "The service") {
  const text = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string; cause?: { code?: string } })?.code ?? (error as { cause?: { code?: string } })?.cause?.code;
  const status = /^(?:Error: )?(\d{3})\b/.exec(text)?.[1] ?? /\bstatus(?: code)? (\d{3})\b/i.exec(text)?.[1];
  if (status) return serviceProblem(service, Number(status));
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || /getaddrinfo/.test(text)) return "That address could not be found. Check the spelling.";
  if (code === "ECONNREFUSED" || /ECONNREFUSED/.test(text)) return `${service} is not answering at that address. Check the address and port.`;
  if (code === "ETIMEDOUT" || /timed? ?out|aborted|AbortError/i.test(text)) return `${service} took too long to answer. Try again in a moment.`;
  if (/certificate|self[- ]signed|SSL|TLS/i.test(text) && !/does not support SSL/i.test(text)) return `${service} did not offer a secure connection that could be trusted. Check the address, or the security settings.`;
  if (/does not support SSL/i.test(text)) return "This server does not use TLS. Edit the connection and untick Use TLS.";
  if (/fetch failed|ECONNRESET|socket hang up|network/i.test(text)) return `${service} could not be reached. Check the address and try again.`;
  return firstSentence(text.split("\n")[0]!);
}
