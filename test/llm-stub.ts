import type { ServerResponse } from "node:http";

/** Answers like a real model server: as one reply, or as a stream when asked. */
export async function sendCompletion(res: ServerResponse, request: { stream?: boolean; model: string }, completion: any, paceMs = 0) {
  if (!request.stream) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(completion));
  }
  const { message, finish_reason } = completion.choices[0];
  const base = { id: completion.id, object: "chat.completion.chunk", created: 0, model: request.model };
  res.setHeader("content-type", "text/event-stream");
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (message.tool_calls) {
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: message.tool_calls.map((call: any, index: number) => ({ index, ...call })) }, finish_reason: null }] });
  } else {
    const pieces = (message.content as string).match(/.{1,4}/gs) ?? [""];
    for (const content of pieces) {
      send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] });
      if (paceMs) await new Promise((resolve) => setTimeout(resolve, paceMs));
    }
  }
  send({ ...base, choices: [{ index: 0, delta: {}, finish_reason }] });
  send({ ...base, choices: [], usage: completion.usage });
  res.end("data: [DONE]\n\n");
}
