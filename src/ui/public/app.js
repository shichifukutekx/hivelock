// Agent and document text is untrusted, so it is only ever added with textContent.
import { createFlow } from "./flow.js";

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const toolLabels = {
  list_documents: () => "Listed documents",
  read_document: (args) => `Read ${args?.name ?? "a document"}`,
  list_rfqs: () => "Listed RFQs",
  read_rfq: (args) => `Read ${args?.name ?? "the RFQ"}`,
  check_items: () => "Ran the quote checks",
  save_report: (args) => `Saved ${args?.fileName ?? "a report"}`,
  list_agents: () => "Looked at the team",
  delegate: (args) => `Handed work to ${args?.agent ?? "an agent"}`,
  create_agent: (args) => `Created agent ${args?.name ?? ""}`,
};
const describeTool = (tool, args) => (toolLabels[tool] ?? (() => `Used ${tool}`))(args);

let agents = [];
let running = false;
let attachedFile = null;
let conversationId;
let viewingPast = false;
const flow = createFlow($("flow-canvas"), $("flow-detail"));

const showTeam = () => {
  $("flow-title").textContent = "Your agent team";
  flow.showTeam(agents);
};
const startFlow = (prompt) => {
  $("flow-title").textContent = "Live flow";
  flow.start(prompt);
};

async function api(path, body) {
  const response = await fetch(path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error ?? "Request failed"), { conversationLost: data.conversationLost });
  return data;
}

/** Renders **bold** as text nodes, without treating anything as HTML. */
function renderAnswer(node, text) {
  text.split(/\*\*(.+?)\*\*/g).forEach((part, index) => {
    node.append(index % 2 ? el("strong", "", part) : part);
  });
}

function scrollDown() {
  const thread = $("thread");
  thread.scrollTop = thread.scrollHeight;
}

function addRun(prompt) {
  $("empty")?.remove();
  const run = el("article", "run");
  const steps = el("ul", "steps");
  run.append(el("p", "prompt", prompt), steps);
  $("thread").append(run);
  scrollDown();
  return { run, steps };
}

function addStep(steps, text, className = "") {
  const item = el("li", className, text);
  steps.append(item);
  return item;
}

/** Spells out exactly what a new agent could do, because that is what a person is approving. */
function approvalText({ tool, args }) {
  if (tool === "create_agent") {
    return [
      `Name: ${args.name}`,
      `Purpose: ${args.description}`,
      `Tools: ${args.tools.join(", ")}`,
      `Needs approval for: ${args.requiresApproval.join(", ") || "Nothing"}`,
      `Model: ${args.model}`,
      `Limits: ${args.maxSteps} steps, ${args.maxTokens.toLocaleString()} tokens`,
      "",
      "Instructions:",
      args.instructions,
    ].join("\n");
  }
  return typeof args?.content === "string" ? args.content : JSON.stringify(args, null, 2);
}

function showApproval(run, id, event) {
  const card = el("div", "approval");
  const allow = el("button", "", "Approve");
  const reject = el("button", "secondary", "Decline");
  const buttons = el("div");
  allow.type = reject.type = "button";
  buttons.append(allow, reject);
  card.append(
    el("h3", "", `Approval needed: ${describeTool(event.tool, event.args).replace(/^Saved/, "Save").replace(/^Created/, "Create")}`),
    el("pre", "", approvalText(event)),
    buttons,
  );
  run.append(card);
  scrollDown();

  const decide = async (approved) => {
    allow.disabled = reject.disabled = true;
    try {
      await api(`/api/runs/${id}/approval`, { approved });
      card.remove();
    } catch (error) {
      allow.disabled = reject.disabled = false;
      alert(error.message);
    }
  };
  allow.onclick = () => decide(true);
  reject.onclick = () => decide(false);
  allow.focus();
}

const fieldLabels = {
  size: "Size", class: "Class", endConnection: "End connection", body: "Body", trim: "Trim", trimNo: "Trim no.",
  seat: "Seat", ball: "Ball", stem: "Stem", disc: "Disc", bore: "Bore", operator: "Operator",
  shutOffPressure: "Pressure", operatingTempMin: "Min temp", operatingTempMax: "Max temp", service: "Service",
  compliance: "Compliance", certification: "Certificates", deliveryDate: "Delivery", specialRequirements: "Special requirements",
};

/** Shows what the agent read from the RFQ, line by line, so a person can compare it with the original. */
function renderParsedData(run, args, result) {
  const items = Array.isArray(args?.items) ? args.items : [];
  const findings = result?.findings ?? [];
  const panel = el("details", "parsed");
  panel.open = true;
  panel.append(el("summary", "", `Parsed data: ${items.length} ${items.length === 1 ? "line" : "lines"}${args?.rfqDate ? ` · RFQ date ${args.rfqDate}` : ""}`));

  for (const item of items) {
    const card = el("section", "parsed-line");
    const quantity = item.quantity ?? "Not stated";
    card.append(el("h4", "", `Line ${item.line} · ${item.valveType} · Qty ${quantity}`));

    const lineFindings = findings.filter((f) => f.line === item.line);
    const missing = lineFindings.flatMap((f) => (f.code.startsWith("MISSING:") ? [f.code.slice(8)] : []));
    const fields = Object.entries(item.attributes ?? {}).filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== "");
    const known = Object.keys(fieldLabels);
    fields.sort(([a], [b]) => (known.indexOf(a) + 1 || 99) - (known.indexOf(b) + 1 || 99));

    const list = el("dl");
    for (const [key, value] of fields) list.append(el("dt", "", fieldLabels[key] ?? key), el("dd", "", String(value)));
    for (const key of missing.filter((m) => m !== "quantity")) {
      list.append(el("dt", "missing", fieldLabels[key] ?? key), el("dd", "missing", "Not stated"));
    }
    card.append(list);

    const problems = lineFindings.filter((f) => !f.code.startsWith("MISSING:"));
    if (problems.length) {
      const notes = el("ul", "parsed-notes");
      for (const problem of problems) notes.append(el("li", problem.severity === "blocker" ? "blocker" : "", problem.message));
      card.append(notes);
    }
    panel.append(card);
  }

  const addNotes = (title, notes) => {
    if (!notes.length) return;
    const list = el("ul", "parsed-notes");
    for (const note of notes) list.append(el("li", "blocker", note));
    panel.append(el("h4", "", title), list);
  };
  addNotes("Contradictions", (args?.contradictions ?? []).map((c) => (c.line ? `Line ${c.line}: ${c.description}` : c.description)));
  addNotes("Suspicious text in the RFQ", args?.suspiciousContent ?? []);

  run.append(panel);
  scrollDown();
}

function finishRun(run, answerText, models, tokens, isError) {
  const answer = el("div", isError ? "answer error" : "answer");
  renderAnswer(answer, answerText);
  run.append(answer);
  const details = [[...models].join(", "), tokens ? `${tokens.toLocaleString()} tokens` : ""].filter(Boolean);
  if (details.length) run.append(el("p", "meta", details.join(" · ")));
  scrollDown();
}

function setRunning(value) {
  running = value;
  $("send").disabled = value;
  $("agent").disabled = value;
  $("new-run").disabled = value;
  $("attach").disabled = value;
}

function setAttachedFile(file) {
  attachedFile = file;
  $("file").value = "";
  $("file-chip").hidden = !file;
  $("file-name").textContent = file ? `Attached: ${file.name}` : "";
}

const readBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
  reader.onerror = () => reject(new Error("This file could not be read."));
  reader.readAsDataURL(file);
});

function clearThread() {
  $("thread").replaceChildren();
  conversationId = undefined;
  viewingPast = false;
  showTeam();
}

async function startRun(prompt, file) {
  if (viewingPast) clearThread();
  setRunning(true);
  startFlow(prompt);
  const { run, steps } = addRun(file ? `${prompt}\n\nAttached: ${file.name}` : prompt);
  const thinking = addStep(steps, "Working", "active");
  const models = new Set();
  let tokens = 0;
  const activeSteps = new Map();
  let checkArgs;

  const end = (text, isError) => {
    thinking.remove();
    finishRun(run, text, models, tokens, isError);
    setRunning(false);
    loadHistory();
    loadAgents();
    $("prompt").focus();
  };

  try {
    let request = prompt;
    if (file) {
      const upload = await api("/api/uploads", { name: file.name, dataBase64: await readBase64(file) });
      request = `${prompt}\n\nRFQ file: ${upload.name}`;
    }
    const started = await api("/api/runs", { agent: $("agent").value, prompt: request, conversationId });
    const { id } = started;
    conversationId = started.conversationId;
    const stream = new EventSource(`/api/runs/${id}/events`);
    stream.onmessage = ({ data }) => {
      const event = JSON.parse(data);
      flow.apply(event);
      const by = event.parentRunId ? `${event.agent}: ` : "";
      const ended = !event.parentRunId;
      if (event.type === "model") {
        if (event.model) models.add(event.model);
        tokens += event.tokens ?? 0;
      } else if (event.type === "tool_started") {
        activeSteps.set(event.runId, addStep(steps, by + describeTool(event.tool, event.args), "active"));
        steps.append(thinking);
        if (event.tool === "check_items") checkArgs = event.args;
      } else if (event.type === "tool_finished") {
        const step = activeSteps.get(event.runId);
        step?.classList.remove("active");
        if (event.isError) step?.classList.add("error");
        else if (event.tool === "check_items") renderParsedData(run, checkArgs, JSON.parse(event.output));
      } else if (event.type === "approval_needed") {
        thinking.textContent = "Waiting for your approval";
        showApproval(run, id, event);
      } else if (event.type === "approval_decided") {
        thinking.textContent = "Working";
        if (!event.approved) addStep(steps, "You declined this action");
        steps.append(thinking);
      } else if (event.type === "finished" && ended) {
        stream.close();
        end(event.answer, false);
      } else if (event.type === "failed" && ended) {
        stream.close();
        conversationId = undefined;
        end(event.message, true);
      }
      scrollDown();
    };
    stream.onerror = () => {
      if (stream.readyState === EventSource.CLOSED) end("Lost connection to the server.", true);
    };
  } catch (error) {
    if (error.conversationLost) conversationId = undefined;
    end(error.message, true);
  }
}

function showPastRuns(pastRuns) {
  if (running) return;
  clearThread();
  viewingPast = true;
  for (const past of pastRuns) {
    const { run, steps } = addRun(past.prompt);
    for (const step of past.steps) {
      const by = step.agent ? `${step.agent}: ` : "";
      if (step.approved === undefined) addStep(steps, by + describeTool(step.tool, step.args), step.isError ? "error" : "");
      else addStep(steps, step.approved ? "Approved by you" : "You declined this action");
      if (step.result) renderParsedData(run, step.args, step.result);
    }
    if (past.answer) finishRun(run, past.answer, past.models, 0, past.status === "failed");
    else run.append(el("p", "meta", "This run did not finish."));
  }
  $("thread").append(el("p", "meta", "This is a past conversation. It cannot be continued; a new message starts a new one."));
  const last = pastRuns.at(-1);
  startFlow(last.prompt);
  $("flow-title").textContent = "Past flow: last message";
  last.events.forEach(flow.apply);
}

/** Groups runs into conversations, newest first, with each conversation's runs in order. */
function groupRuns(runs) {
  const groups = new Map();
  for (const past of runs) {
    const key = past.conversationId ?? past.runId;
    groups.set(key, [past, ...(groups.get(key) ?? [])]);
  }
  return [...groups.values()];
}

async function loadHistory() {
  const runs = await api("/api/history");
  $("history").replaceChildren(...groupRuns(runs).map((pastRuns) => {
    const past = pastRuns[0];
    const last = pastRuns.at(-1);
    const item = el("li");
    const button = el("button");
    button.type = "button";
    const when = new Date(past.at).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
    const failed = last.status === "failed";
    button.append(el("span", "", past.prompt), el("small", failed ? "failed" : "", failed ? `Failed · ${when}` : when));
    button.onclick = () => showPastRuns(pastRuns);
    item.append(button);
    return item;
  }));
}

function showAgentInfo() {
  const agent = agents.find((a) => a.name === $("agent").value);
  if (!agent) return;
  const approval = agent.requiresApproval.length ? ` · Needs approval: ${agent.requiresApproval.join(", ")}` : "";
  $("agent-info").textContent = `${agent.description} Tools: ${agent.tools.join(", ")}${approval}`;
  $("attach").hidden = !agent.acceptsFiles;
  if (!agent.acceptsFiles) setAttachedFile(null);
}

async function loadAgents() {
  const selected = $("agent").value;
  agents = await api("/api/agents");
  $("agent").replaceChildren(...agents.map((a) => {
    const option = el("option", "", a.createdByAgent ? `${a.name} (created)` : a.name);
    option.value = a.name;
    return option;
  }));
  if (agents.some((a) => a.name === selected)) $("agent").value = selected;
  showAgentInfo();
}

$("agent").onchange = () => {
  clearThread();
  showAgentInfo();
};
$("toggle-flow").onclick = () => {
  const hidden = $("flow").classList.toggle("closed");
  $("toggle-flow").textContent = hidden ? "Show flow" : "Hide flow";
  $("toggle-flow").setAttribute("aria-expanded", String(!hidden));
};
$("new-run").onclick = () => {
  clearThread();
  $("prompt").focus();
};
$("composer").onsubmit = (event) => {
  event.preventDefault();
  const file = attachedFile;
  const prompt = $("prompt").value.trim() || (file ? "Check this RFQ." : "");
  if (!prompt || running) return;
  $("prompt").value = "";
  setAttachedFile(null);
  startRun(prompt, file);
};
$("attach").onclick = () => $("file").click();
$("file").onchange = () => setAttachedFile($("file").files[0] ?? null);
$("file-remove").onclick = () => setAttachedFile(null);
$("prompt").onkeydown = (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("composer").requestSubmit();
  }
};

await loadAgents();
showTeam();
loadHistory();
$("prompt").focus();
