import { approve, ask, call, flow, slot, think, type Template } from "./types.ts";

export const qualityTemplates: Template[] = [
  {
    id: "nonconformance-report",
    name: "Non-conformance report draft",
    outcome: "Shop-floor notes become a complete NCR draft, with the gaps listed, ready for the quality engineer.",
    description: "Turns a short description of a problem into a structured non-conformance report: what was found, against which requirement, the quantity affected and proposed containment. A quality engineer reviews it, then it is added to the NCR log.",
    category: "quality", role: "Quality engineer", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Adds the NCR to the log once approved.")],
    questions: [ask.id("spreadsheet", "NCR log spreadsheet id"), ask.text("range", "Range", undefined, { default: "NCR!A:E" })],
    run: { kind: "manual", note: "Start a run with what was found.", input: { reference: "NCR number, or your own reference", part: "Part number and batch", found: "What was found, where and by whom" } },
    agent: {
      name: "nonconformance-report", model: "main", knowledge: true, humanDecides: true,
      description: "Drafts a non-conformance report from a short description.",
      instructions: `You draft non-conformance reports for a quality engineer. Find the requirement in the workspace documents: the drawing, specification or procedure. Quote it and name the file. If you cannot find it, write "Requirement not found".

Use these headings:
1. Description: what was found, in factual terms.
2. Requirement: what it should have been.
3. Evidence: measurements or observations in the note.
4. Extent: quantity affected and batches, as stated. If unknown, list what needs to be counted.
5. Proposed containment: quarantine, sort, or stop, for the engineer to confirm.
6. Proposed disposition: list the options that apply (rework, repair, use as is, return to supplier, scrap), without choosing.
7. Missing information.

State facts and do not assign blame. Do not name a root cause: that comes later, in a CAPA. A use-as-is disposition can need customer agreement, so say so where it applies.`,
    },
    workflow: flow(
      think("draft", "Draft the NCR", `Draft an NCR.\nReference: {{input.reference}}\nPart and batch: {{input.part}}\n\nWhat was found:\n{{input.found}}`),
      approve("review", "Quality engineer reviews", `Add NCR {{input.reference}} to the log as a draft?\n\n{{steps.draft.output}}`),
      call("log", "Add to the NCR log", "sheet", "append_rows", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]", rows: [["{{input.reference}}", "{{input.part}}", "Draft", "{{steps.draft.output}}"]] }),
    ),
  },
  {
    id: "capa-draft",
    name: "CAPA draft with root cause prompts",
    outcome: "A structured corrective action draft that asks the right questions and does not stop at human error.",
    description: "Works through a non-conformance with a quality engineer in chat: problem statement, containment, five whys, corrective and preventive actions, and how effectiveness will be checked. Every cause is marked as confirmed or still to verify.",
    category: "quality", role: "Quality manager", difficulty: "intermediate",
    connections: [], questions: [ask.text("standard", "Quality standard", "For example ISO 9001, IATF 16949 or AS9100.", { default: "ISO 9001" })],
    run: { kind: "chat", note: "Open a chat and describe the problem, or name the NCR in Files." },
    agent: {
      name: "capa-draft", model: "main", knowledge: true, files: ["list_files", "read_file", "save_file"], humanDecides: true,
      description: "Guides a corrective and preventive action, with root cause analysis, as a draft.",
      instructions: `You help a quality engineer write a corrective and preventive action under [[standard]]. Search the workspace documents for your CAPA procedure, and past NCRs on this part or process, and follow that procedure's format if there is one.

Work in this order, asking for what is missing:
1. Problem statement: what, where, when, how many, how it was found. No causes.
2. Containment already in place, and whether other stock or shipments could be affected.
3. Root cause: five whys, one step at a time. Ask the person to answer each why from evidence. Consider method, machine, material, measurement, people and environment. Do not accept "operator error" or "training" as a root cause: ask why the process allowed it.
4. Also ask why it was not detected.
5. Corrective actions: each with an owner, a date, and the cause it addresses.
6. Preventive actions on similar parts or processes.
7. Effectiveness check: what will be measured, for how long, and what counts as success.

Mark each cause Confirmed by evidence, or Still to verify. Save a draft as .txt only when asked. Saving asks for approval. Only a person closes a CAPA.`,
    },
  },
  {
    id: "incoming-inspection-comparison",
    name: "Incoming inspection comparison",
    outcome: "Supplier certificates and inspection results are compared with your specification, line by line.",
    description: "Reads the certificate of conformance or material test report, the purchase order and the specification, and compares every value with its limit. Out-of-limit or missing values are flagged. An inspector decides, then the result goes in the inspection log.",
    category: "quality", role: "Incoming inspector", difficulty: "intermediate",
    connections: [slot("sheet", "google_sheets", "Adds the inspector's result to the log.")],
    questions: [ask.id("spreadsheet", "Inspection log spreadsheet id"), ask.text("range", "Range", undefined, { default: "Incoming!A:D" })],
    run: { kind: "manual", note: "Upload the certificate to Files and specifications to the documents, then start a run.", input: { lot: "Lot or receipt number", certificate: "Certificate file name", specification: "Specification name or number" } },
    agent: {
      name: "incoming-inspection-comparison", model: "main", knowledge: true, files: ["read_file"], humanDecides: true,
      description: "Compares supplier certificates with the specification and flags anything out of limit.",
      instructions: `You compare supplier certificates with specifications. Read the certificate file. Find the specification in the workspace documents. If you cannot find it, say so and stop: limits must never come from memory or from the certificate itself.

Make a list with one line per characteristic: chemistry, mechanical properties, dimensions, heat treatment, coatings, and any other requirement. For each one give the specification limit with its unit, the reported value, and a result: Within limit, Out of limit, or Not reported.

Compare numbers exactly. Do not round. If units differ, show the conversion. Check also:
- Heat or lot number, material grade, specification revision and quantity match.
- The certificate is signed or stamped if the specification requires it, and names the mill or laboratory.

First line: ALL WITHIN LIMITS or ATTENTION NEEDED. A value exactly on a limit is within it unless the specification says otherwise. You do not accept or reject material.`,
    },
    workflow: flow(
      think("compare", "Compare with the specification", `Lot: {{input.lot}}\nCertificate file: {{input.certificate}}\nSpecification: {{input.specification}}`),
      approve("decide", "Inspector decides", `Log lot {{input.lot}} as reviewed? Accepting or holding the material stays with you.\n\n{{steps.compare.output}}`),
      call("log", "Add to the inspection log", "sheet", "append_rows", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]", rows: [["{{input.lot}}", "{{input.specification}}", "Reviewed by a person", "{{steps.compare.output}}"]] }),
    ),
  },
  {
    id: "audit-evidence-collection",
    name: "Audit evidence collection",
    outcome: "An evidence map for each clause of your standard, with the gaps found before the auditor finds them.",
    description: "Give the clauses in scope, and the agent searches your documents for evidence for each requirement. It reports what exists, how recent it is and where the gaps are. It never claims compliance.",
    category: "quality", role: "Quality manager", difficulty: "intermediate",
    connections: [], questions: [ask.text("standard", "Standard being audited", "For example ISO 9001:2015.")],
    run: { kind: "chat", note: "Upload your procedures, records and past audit reports to the documents, then name the clauses." },
    agent: {
      name: "audit-evidence-collection", model: "main", knowledge: true, files: ["list_files", "read_file", "save_file"], humanDecides: true,
      description: "Maps documents to audit clauses and lists gaps. It never claims compliance.",
      instructions: `You prepare evidence for a [[standard]] audit. The person gives clauses in scope. If the standard's text is not in the workspace documents, use only the clause numbers and wording the person gives, and do not recite requirements from memory.

For each clause, search the documents and files with several wordings. Give:
- Requirement, as supplied.
- Evidence found: file, section, date or revision if shown.
- Strength: Record (proof it was done), Procedure (says what should be done), or None.
- Gap: what an auditor would ask for next.
- Owner: a role, if the documents make it clear.

A procedure alone does not prove something happened. Flag documents that look out of date or lack a revision. Finish with a list of gaps, most serious first. Never write "compliant": you can only report what evidence exists. When asked, save the result as a .csv. Saving asks for approval.`,
    },
  },
  {
    id: "document-review-reminders",
    name: "Controlled document review reminders",
    outcome: "Procedures and work instructions are reviewed on time, with owners told in good time.",
    description: "Reads your document master list, finds what is overdue or coming due for its periodic review, and groups it by owner. After approval the list goes to the quality channel.",
    category: "quality", role: "Document controller", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads the document master list."), slot("chat", "slack", "Posts the reminder once approved.")],
    questions: [ask.id("spreadsheet", "Master list spreadsheet id"), ask.text("range", "Range", "Columns for number, title, revision, owner, next review date.", { default: "Documents!A:E" }), ask.number("days", "Days of notice", 45, 7, 365), ask.channel("channel", "Quality channel")],
    run: { kind: "schedule", cron: "0 8 1,15 * *", note: "The 1st and 15th of each month at 08:00." },
    agent: {
      name: "document-review-reminders", model: "fast",
      description: "Lists controlled documents due for review, grouped by owner.",
      instructions: `You track periodic reviews of controlled documents. The rows hold document number, title, revision, owner and next review date.

Report, grouped by owner:
- Overdue: past the review date, oldest first, with days overdue.
- Due within [[days]] days.
Then "Could not check" for missing dates or owners. Give each document's number, title, revision and date.

End with the totals. Do not comment on the content of the documents. If nothing is due, say so in one line.`,
    },
    workflow: flow(
      call("list", "Read the master list", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("due", "Find what is due", `Check this master list:\n\n{{steps.list.output}}`),
      approve("check", "Document controller checks it", `Post this to [[channel]]?\n\n{{steps.due.output}}`),
      call("post", "Post the reminder", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.due.output}}" }),
    ),
  },
  {
    id: "calibration-due-watch",
    name: "Calibration due watch",
    outcome: "Gauges and instruments are recalled before they go out of date, with overdue ones flagged for use.",
    description: "Reads your calibration register, lists instruments overdue or coming due, and flags overdue ones that should not be used until checked. After approval the list goes to the metrology channel.",
    category: "quality", role: "Metrology technician", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads the calibration register."), slot("chat", "teams", "Posts the list once approved.")],
    questions: [ask.id("spreadsheet", "Register spreadsheet id"), ask.text("range", "Range", "Columns for gauge id, description, location, last calibrated, next due.", { default: "Calibration!A:E" }), ask.number("days", "Days of notice", 30, 1, 180)],
    run: { kind: "schedule", cron: "0 7 * * 1", note: "Mondays at 07:00." },
    agent: {
      name: "calibration-due-watch", model: "fast",
      description: "Lists instruments overdue or coming due for calibration.",
      instructions: `You watch a calibration register. List under "Overdue: do not use until checked" every instrument past its due date, with id, description, location and days overdue. Then "Due within [[days]] days", soonest first, grouped by location, so a technician can collect them in one round. Then "Could not check" for missing dates.

An overdue instrument may have been used to accept product, so add this line if any are overdue: "Consider whether results from these instruments need review since their due date." If nothing is due, say so in one line.`,
    },
    workflow: flow(
      call("register", "Read the register", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("due", "Find what is due", `Check this calibration register:\n\n{{steps.register.output}}`),
      approve("check", "Technician checks it", `Post this list?\n\n{{steps.due.output}}`),
      call("post", "Post the list", "chat", "post_message", { text: "{{steps.due.output}}" }),
    ),
  },
  {
    id: "customer-complaint-8d",
    name: "Customer complaint 8D draft",
    outcome: "A complaint email becomes a first 8D draft and a calm acknowledgement for the customer.",
    description: "Reads a quality complaint and pre-fills the first steps of an 8D report: team, problem description and interim containment questions. It drafts the acknowledgement separately in the same note. A quality manager approves a post to the quality channel. Nothing goes to the customer.",
    category: "quality", role: "Quality manager", difficulty: "intermediate",
    connections: [slot("chat", "slack", "Posts the draft to the quality channel once approved.")],
    questions: [ask.channel("channel", "Quality channel")],
    run: { kind: "email", note: "An admin adds a mailbox trigger on the complaints inbox." },
    agent: {
      name: "customer-complaint-8d", model: "main", knowledge: true, humanDecides: true,
      description: "Drafts the opening steps of an 8D report from a customer complaint.",
      instructions: `You open an 8D report from a customer complaint. Search the workspace documents for this part, customer procedure and past complaints.

Write:
- D1 Team: roles needed, not names.
- D2 Problem description: what, where, when, how many, as the customer states it. List what is missing, such as part number, batch, photos or quantities.
- D3 Interim containment: what to check, including stock at your site, in transit and at the customer.
- D4 onwards: "To be completed once the investigation has evidence."

Then under "Draft acknowledgement" write a short note to the customer: receipt, a person is on it, what you need from them. Do not accept fault, offer credit, state a cause, or give a date.`,
    },
    workflow: flow(
      think("draft", "Draft the 8D", `Customer complaint.\nFrom: {{input.fromName}} {{input.from}}\nSubject: {{input.subject}}\nAttachment names: {{input.attachments}}\n\nMessage:\n{{input.text}}`),
      approve("review", "Quality manager reviews", `Post this draft to [[channel]]?\n\n{{steps.draft.output}}`),
      call("post", "Post the draft", "chat", "post_message", { channel: "[[channel]]", text: "Complaint from {{input.from}}: {{input.subject}}\n\n{{steps.draft.output}}" }),
    ),
  },
];
