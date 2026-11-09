// Draws a run as a live graph of agents and tools. All run text is untrusted, so it only uses textContent.
const NODE_WIDTH = 176;
const NODE_HEIGHT = 62;
const COLUMN_GAP = 56;
const ROW_GAP = 14;
const MIN_ZOOM = 0.6;
const SVG = "http://www.w3.org/2000/svg";

const statusLabels = {
  ready: "Ready", running: "Working", waiting: "Waiting for you", done: "Done", error: "Failed", declined: "Declined",
};
const toolNames = {
  list_agents: "List agents", create_agent: "Create agent", list_documents: "List documents", read_document: "Read document",
  list_rfqs: "List RFQs", read_rfq: "Read RFQ", check_items: "Run quote checks", save_report: "Save report",
};

const pretty = (value) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function createFlow(canvas, detail) {
  let root;
  let runs = new Map();
  let selected;
  let nextId = 0;

  const addNode = (parent, kind, label, status, fields = {}) => {
    const node = { id: ++nextId, kind, label, status, fields, children: [], parent, startedAt: undefined, endedAt: undefined };
    parent?.children.push(node);
    return node;
  };

  const setStatus = (node, status, at) => {
    node.status = status;
    if (status === "running") node.startedAt ??= at;
    else if (status !== "waiting") node.endedAt = at;
  };

  /** Places each leaf on its own row and centers parents on their children. */
  function layout(node, depth, row) {
    node.x = depth * (NODE_WIDTH + COLUMN_GAP);
    if (node.children.length === 0) {
      node.y = row * (NODE_HEIGHT + ROW_GAP);
      return row + 1;
    }
    let next = row;
    for (const child of node.children) next = layout(child, depth + 1, next);
    node.y = (node.children[0].y + node.children.at(-1).y) / 2;
    return next;
  }

  const flatten = (node) => [node, ...node.children.flatMap(flatten)];

  function subtitle(node) {
    if (node.kind === "agent" && node.calls) {
      return `${plural(node.calls, "model call")} · ${node.tokens.toLocaleString()} tokens`;
    }
    return node.note ?? "";
  }

  function draw() {
    canvas.replaceChildren();
    if (!root) return;
    layout(root, 0, 0);
    const nodes = flatten(root);
    const width = Math.max(...nodes.map((n) => n.x)) + NODE_WIDTH;
    const height = Math.max(...nodes.map((n) => n.y)) + NODE_HEIGHT;

    const lines = document.createElementNS(SVG, "svg");
    lines.setAttribute("width", width);
    lines.setAttribute("height", height);
    lines.setAttribute("aria-hidden", "true");
    for (const node of nodes) {
      for (const child of node.children) {
        const fromX = node.x + NODE_WIDTH;
        const fromY = node.y + NODE_HEIGHT / 2;
        const toY = child.y + NODE_HEIGHT / 2;
        const middle = fromX + COLUMN_GAP / 2;
        const path = document.createElementNS(SVG, "path");
        path.setAttribute("d", `M${fromX},${fromY} C${middle},${fromY} ${middle},${toY} ${child.x},${toY}`);
        path.setAttribute("class", child.status === "running" || child.status === "waiting" ? "live" : "");
        lines.append(path);
      }
    }

    const area = document.createElement("div");
    area.className = "flow-area";
    area.style.width = `${width}px`;
    area.style.height = `${height}px`;
    area.append(lines);

    for (const node of nodes) {
      const box = document.createElement("button");
      box.type = "button";
      box.className = `flow-node ${node.kind} ${node.status}${node === selected ? " selected" : ""}`;
      box.style.left = `${node.x}px`;
      box.style.top = `${node.y}px`;
      box.style.width = `${NODE_WIDTH}px`;
      box.style.height = `${NODE_HEIGHT}px`;
      const title = document.createElement("strong");
      title.textContent = node.label;
      const small = document.createElement("small");
      small.textContent = subtitle(node) || statusLabels[node.status] || "";
      box.append(title, small);
      box.title = `${node.label}: ${statusLabels[node.status] ?? ""}`;
      box.onclick = () => select(node);
      area.append(box);
    }
    // Shrinks a wide graph to fit the panel. Beyond the minimum size the panel scrolls instead.
    const zoom = Math.max(MIN_ZOOM, Math.min(1, (canvas.clientWidth - 32) / width));
    area.style.zoom = zoom;
    canvas.append(area);
    const active = nodes.filter((n) => n.status === "running" || n.status === "waiting").at(-1);
    // Moves only the canvas, so following the work never scrolls the rest of the page.
    if (active) {
      canvas.scrollLeft = Math.max(0, (active.x + NODE_WIDTH) * zoom + 32 - canvas.clientWidth);
      canvas.scrollTop = Math.max(0, (active.y + NODE_HEIGHT) * zoom + 32 - canvas.clientHeight);
    }
  }

  function showDetail() {
    detail.replaceChildren();
    detail.hidden = !selected;
    if (!selected) return;
    const heading = document.createElement("h3");
    heading.textContent = selected.label;
    const status = document.createElement("p");
    // Past runs log some steps with a single time, so a zero means unknown rather than instant.
    const elapsed = (new Date(selected.endedAt) - new Date(selected.startedAt)) / 1000;
    const seconds = elapsed >= 0.1 ? ` · ${elapsed.toFixed(1)} s` : "";
    status.textContent = `${statusLabels[selected.status] ?? selected.status}${seconds}`;
    detail.append(heading, status);
    for (const [name, value] of Object.entries(selected.fields)) {
      if (value === undefined || value === "") continue;
      const label = document.createElement("h4");
      label.textContent = name;
      const text = document.createElement("pre");
      text.textContent = pretty(value);
      detail.append(label, text);
    }
  }

  function select(node) {
    selected = selected === node ? undefined : node;
    draw();
    showDetail();
  }

  function reset() {
    root = undefined;
    runs = new Map();
    selected = undefined;
    showDetail();
  }

  function apply(event) {
    if (!root) return;
    const run = runs.get(event.runId);

    if (event.type === "started") {
      const parentRun = runs.get(event.parentRunId);
      const reserved = parentRun?.handoff;
      const node = reserved ?? addNode(parentRun?.node ?? root, "agent", event.agent, "running");
      if (parentRun) parentRun.handoff = undefined;
      node.fields.Task = event.prompt;
      setStatus(node, "running", event.at);
      runs.set(event.runId, { node, isHelper: !!event.parentRunId, handoff: undefined, lastHandoff: undefined });
    } else if (!run) {
      return;
    } else if (event.type === "model") {
      run.node.calls = (run.node.calls ?? 0) + 1;
      run.node.tokens = (run.node.tokens ?? 0) + (event.tokens ?? 0);
      if (event.model) run.node.fields.Model = event.model;
    } else if (event.type === "approval_needed") {
      const node = addNode(run.node, "tool", toolNames[event.tool] ?? event.tool, "waiting", { Input: event.args });
      node.tool = event.tool;
      node.startedAt = event.at;
      node.note = "Waiting for you";
      run.approval = node;
    } else if (event.type === "approval_decided") {
      if (run.approval) {
        run.approval.note = event.approved ? "Approved by you" : "Declined by you";
        setStatus(run.approval, event.approved ? "running" : "declined", event.at);
        if (!event.approved) run.approval = undefined;
      }
    } else if (event.type === "tool_started") {
      if (event.tool === "delegate") {
        const name = event.args?.agent ?? "Agent";
        run.handoff = addNode(run.node, "agent", name, "running", { Task: event.args?.task });
        run.lastHandoff = run.handoff;
      } else {
        const node = run.approval ?? addNode(run.node, "tool", toolNames[event.tool] ?? event.tool, "running");
        run.approval = undefined;
        node.tool = event.tool;
        node.fields.Input = event.args;
        setStatus(node, "running", event.at);
        run.active = node;
      }
    } else if (event.type === "tool_finished") {
      const node = event.tool === "delegate" ? run.lastHandoff : run.active;
      if (node && event.tool === "delegate") {
        if (event.isError) {
          node.fields.Problem = event.output;
          setStatus(node, "error", event.at);
        }
      } else if (node) {
        if (event.output) node.fields.Output = event.output;
        setStatus(node, event.isError ? "error" : "done", event.at);
        if (event.tool === "create_agent" && !event.isError) node.note = `New agent: ${node.fields.Input?.name}`;
      }
    } else if (event.type === "finished") {
      run.node.fields.Answer = event.answer;
      setStatus(run.node, "done", event.at);
      if (!run.isHelper) {
        addNode(run.node, "answer", "Answer", "done", { Answer: event.answer });
        root.status = "done";
      }
    } else if (event.type === "failed") {
      run.node.fields.Problem = event.message;
      setStatus(run.node, "error", event.at);
      if (!run.isHelper) root.status = "error";
    }
    draw();
    if (selected) showDetail();
  }

  /** Begins a new picture for one request. */
  function start(prompt) {
    reset();
    root = addNode(undefined, "request", "Your request", "running", { Request: prompt });
    draw();
  }

  /** Shows who is on the team when nothing is running. */
  function showTeam(agents) {
    reset();
    const manager = agents.find((a) => a.managesAgents);
    if (!manager) return draw();
    const describe = (agent) => ({
      Does: agent.description,
      Tools: agent.tools.join(", "),
      "Needs approval": agent.requiresApproval.join(", ") || "Nothing",
      Model: agent.model,
    });
    root = addNode(undefined, "agent", manager.name, "ready", describe(manager));
    root.note = "Manages the team";
    for (const agent of agents.filter((a) => !a.managesAgents)) {
      const node = addNode(root, "agent", agent.name, "ready", describe(agent));
      node.note = agent.createdByAgent ? "Created by an agent" : plural(agent.tools.length, "tool");
    }
    draw();
  }

  return { start, apply, showTeam };
}
