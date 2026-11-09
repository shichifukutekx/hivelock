import { z } from "zod";
import { safeFetch } from "../net/safe-fetch.ts";
import { PermanentError, registerConnector, type ActionContext } from "./types.ts";
import { serviceProblem } from "../plain-errors.ts";

const slackApi = () => process.env.SLACK_API_URL ?? "https://slack.com/api";

const slackCredentials = z.object({ botToken: z.string().min(10) });
const postMessage = z.object({ channel: z.string().min(1).max(100), text: z.string().min(1).max(40_000) });
const history = z.object({ channel: z.string().min(1).max(100), limit: z.coerce.number().int().min(1).max(200).default(20) });

async function slack(token: string, method: string, body: unknown, { network }: ActionContext) {
  const url = `${slackApi()}/${method}`;
  const response = await safeFetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  }, { ...network, onlyOrigin: new URL(url).origin });
  const data = await response.json() as { ok: boolean; error?: string } & Record<string, unknown>;
  if (!data.ok) throw new PermanentError(`Slack refused this: ${data.error ?? response.status}.`);
  return data;
}

registerConnector({
  name: "slack",
  label: "Slack",
  category: "chat",
  description: "Post messages and read channels with a Slack bot.",
  fields: [{ name: "botToken", label: "Bot token", type: "password", required: true }],
  credentials: slackCredentials,
  actions: {
    post_message: {
      label: "Post a message",
      changesData: true,
      params: postMessage,
      run: async (connection, params, context) => {
        const { channel, ts } = await slack(slackCredentials.parse(connection).botToken, "chat.postMessage", postMessage.parse(params), context);
        return { channel, ts };
      },
    },
    list_messages: {
      label: "Read recent messages",
      changesData: false,
      params: history,
      run: async (connection, params, context) => {
        const { messages } = await slack(slackCredentials.parse(connection).botToken, "conversations.history", history.parse(params), context);
        return { messages };
      },
    },
  },
  test: async (connection, context) => {
    await slack(slackCredentials.parse(connection).botToken, "auth.test", {}, context);
  },
});

const teamsCredentials = z.object({ webhookUrl: z.url() });
const teamsMessage = z.object({ text: z.string().min(1).max(20_000) });

/** A Teams webhook address is itself the credential, so it must be a real Microsoft one. */
function teamsUrl(address: string, { network }: ActionContext) {
  const url = new URL(address);
  const official = url.protocol === "https:" && /(^|\.)(webhook\.office\.com|logic\.azure\.com|api\.powerplatform\.com)$/i.test(url.hostname);
  if (!official && !network.allowedPrivateHosts.includes(url.hostname)) throw new PermanentError("This is not a Microsoft Teams webhook address.");
  return url;
}

registerConnector({
  name: "teams",
  label: "Microsoft Teams",
  category: "chat",
  description: "Post messages to a Teams channel through a workflow webhook.",
  fields: [{ name: "webhookUrl", label: "Webhook URL", type: "password", required: true }],
  credentials: teamsCredentials,
  actions: {
    post_message: {
      label: "Post a message",
      changesData: true,
      params: teamsMessage,
      run: async (connection, params, context) => {
        const url = teamsUrl(teamsCredentials.parse(connection).webhookUrl, context);
        const { text } = teamsMessage.parse(params);
        const response = await safeFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }, { ...context.network, onlyOrigin: url.origin });
        if (!response.ok) throw new PermanentError(serviceProblem("Microsoft Teams", response.status));
        return { sent: true };
      },
    },
  },
  test: async (connection, context) => {
    teamsUrl(teamsCredentials.parse(connection).webhookUrl, context);
  },
});
