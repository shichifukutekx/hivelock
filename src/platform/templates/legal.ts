import { approve, ask, call, flow, slot, think, type Template } from "./types.ts";

const NOT_ADVICE = `This is a draft review to help a qualified person. It is not legal advice. Do not state whether a clause is enforceable or what a court would do.`;

export const legalTemplates: Template[] = [
  {
    id: "contract-clause-review",
    name: "Contract clause review",
    outcome: "A clause-by-clause comparison of a contract with your playbook, as a draft for your lawyer.",
    description: "Reads a contract from Files and compares each key clause with the positions in your playbook document. It marks each one as acceptable, a deviation or missing, and suggests fallback wording only from the playbook. A person reviews everything.",
    category: "legal", role: "In-house counsel", difficulty: "advanced",
    connections: [], questions: [],
    run: { kind: "chat", note: "Upload your contract playbook to the documents and the contract to Files, then name it in a chat." },
    agent: {
      name: "contract-clause-review", model: "main", knowledge: true, files: ["list_files", "read_file", "save_file"], humanDecides: true,
      description: "Compares a contract with the playbook clause by clause, as a draft for a lawyer.",
      instructions: `You review contracts against the playbook in the workspace documents. If there is no playbook, say so, and offer only to summarise the contract and list its clauses.

Read the whole contract. Say what it is, who the parties are, and its date and term.

Cover these clauses, and any others in the playbook: liability cap and exclusions, indemnities, intellectual property, confidentiality, data protection, payment, term and termination, renewal, governing law and disputes, assignment, insurance, warranties.

For each one give:
- Where: clause number.
- What it says: a short summary with a brief quote.
- Playbook position: with the file name.
- Assessment: Acceptable, Deviation, or Missing.
- Severity: High, Medium or Low, by the playbook's rules. If it has none, leave this blank.
- Suggested wording: only fallback text from the playbook. If it has none, write "Needs a lawyer".

Start with a short list of the top issues. Check definitions and any schedule that changes a clause. Look out for terms hidden in order forms. ${NOT_ADVICE} Save a copy as .txt only when asked. Saving asks for approval.`,
    },
  },
  {
    id: "nda-triage",
    name: "NDA triage",
    outcome: "Incoming NDAs are sorted into standard and needs-review, saving your lawyers the simple ones.",
    description: "Takes the text of an NDA, checks it against your NDA checklist, and lists anything unusual such as a long term, non-solicitation terms or residuals. A person always decides, and the result goes to the legal channel. It signs and approves nothing.",
    category: "legal", role: "Legal operations", difficulty: "intermediate",
    connections: [slot("chat", "slack", "Posts the triage to the legal channel once approved.")],
    questions: [ask.number("years", "Longest usual term (years)", 3, 1, 25), ask.channel("channel", "Legal channel")],
    run: { kind: "manual", note: "Start a run with the NDA text. A mailbox trigger only sees the message, not attachments, so paste the text in.", input: { counterparty: "Other party", text: "The NDA text" } },
    agent: {
      name: "nda-triage", model: "main", knowledge: true, humanDecides: true,
      description: "Checks an NDA against the checklist, and sorts it for a lawyer.",
      instructions: `You triage NDAs. Use the NDA checklist in the workspace documents if there is one. Otherwise check the points below.

Check:
- Mutual or one-way, and who is protected.
- Definition of confidential information: is it limited, or does it cover everything?
- Term of the agreement and how long confidentiality lasts. More than [[years]] years is unusual, except for trade secrets.
- Usual exceptions: public, already known, independently developed, legally required disclosure.
- Return or destruction of information.
- Anything beyond confidentiality: non-solicit, non-compete, exclusivity, IP licence, residuals, penalties or liquidated damages, audit rights.
- Governing law and courts.

First line: SUGGEST STANDARD or SUGGEST REVIEW, and any item beyond confidentiality forces SUGGEST REVIEW. Then list each point with the clause number and a short quote. ${NOT_ADVICE} This suggestion does not approve the NDA.`,
    },
    workflow: flow(
      think("triage", "Check the NDA", `NDA with {{input.counterparty}}:\n\n{{input.text}}`),
      approve("review", "Legal reviews", `Post this to [[channel]]? A person still has to approve the NDA itself.\n\n{{steps.triage.output}}`),
      call("post", "Post the triage", "chat", "post_message", { channel: "[[channel]]", text: "NDA with {{input.counterparty}}\n\n{{steps.triage.output}}" }),
    ),
  },
  {
    id: "contract-renewal-watch",
    name: "Contract renewal watch",
    outcome: "Auto-renewals and notice dates are spotted while you can still act on them.",
    description: "Reads your contract register, works out the last day to give notice for each contract, and lists those coming up. After approval the list goes to the legal channel.",
    category: "legal", role: "Legal operations", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads the contract register."), slot("chat", "slack", "Posts the list once approved.")],
    questions: [ask.id("spreadsheet", "Register spreadsheet id"), ask.text("range", "Range", "Columns for contract, counterparty, owner, end date, auto-renews, notice days.", { default: "Contracts!A:F" }), ask.number("days", "Days of warning", 90, 7, 365), ask.channel("channel", "Legal channel")],
    run: { kind: "schedule", cron: "0 8 * * 1", note: "Mondays at 08:00." },
    agent: {
      name: "contract-renewal-watch", model: "fast", humanDecides: true,
      description: "Works out notice dates from the contract register and lists those coming up.",
      instructions: `You watch contract dates. For each row, the last notice date is the end date minus the notice days. List contracts whose last notice date falls within [[days]] days, soonest first. Give the contract, counterparty, owner, end date, whether it auto-renews, and the last notice date.

Mark auto-renewing ones clearly, because missing the date commits the company. Dates already past go under "Notice date passed". Rows with missing dates or notice days go under "Could not check". Show your working for any you were unsure of. The register may not match the signed contract, so the owner should confirm the dates in the contract itself.`,
    },
    workflow: flow(
      call("register", "Read the register", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("dates", "Work out notice dates", `Check this contract register:\n\n{{steps.register.output}}`),
      approve("check", "Legal checks it", `Post this to [[channel]]?\n\n{{steps.dates.output}}`),
      call("post", "Post the list", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.dates.output}}" }),
    ),
  },
  {
    id: "contract-version-compare",
    name: "Contract redline summary",
    outcome: "A plain summary of what really changed between two versions of a contract.",
    description: "Reads two versions from Files and reports each change in substance, not formatting. It marks which party each change favours, so a lawyer can go straight to what matters. Useful when a counterparty returns a clean copy with no tracked changes.",
    category: "legal", role: "In-house counsel", difficulty: "intermediate",
    connections: [], questions: [],
    run: { kind: "chat", note: "Upload both versions to Files, then name them in a chat." },
    agent: {
      name: "contract-version-compare", model: "main", files: ["list_files", "read_file"], humanDecides: true,
      description: "Summarises what changed in substance between two versions of a contract.",
      instructions: `You compare two versions of a contract. Read both files in full. Confirm which is earlier, by date or by what the person says.

Report every change in substance, in clause order:
- Clause number in each version.
- Before and after, as short quotes.
- What it means in one plain sentence.
- Which party it favours: Us, Them, or Neutral. Ask which party "us" is if unclear.

Do not report spelling or formatting, beyond a one-line count. Watch for changes that are easy to miss: a moved definition, "shall" changed to "may", a deleted exception, a changed number or date, a new schedule, and changes in order of precedence. If the files could not be fully read, for example a scan, say which parts are missing, because a missed change is worse than none reported. ${NOT_ADVICE}`,
    },
  },
  {
    id: "contract-obligations-extract",
    name: "Contract obligations list",
    outcome: "A signed contract becomes a dated list of who must do what.",
    description: "Reads a signed contract and extracts every obligation and date: deliverables, reports, notices, price reviews and renewals. The list can be added to your obligations tracker after a person checks it, so nothing lives only in a PDF.",
    category: "legal", role: "Contract manager", difficulty: "intermediate",
    connections: [slot("sheet", "google_sheets", "Adds the list to your tracker when you approve it.")],
    questions: [ask.id("spreadsheet", "Tracker spreadsheet id"), ask.text("range", "Range", undefined, { default: "Obligations!A:F" })],
    run: { kind: "chat", note: "Upload the contract to Files, then name it in a chat." },
    agent: {
      name: "contract-obligations-extract", model: "main", files: ["list_files", "read_file"], tools: [["sheet", "append_rows"]], humanDecides: true,
      description: "Extracts obligations and dates from a signed contract into a list.",
      instructions: `You extract obligations from a signed contract. Read it in full, with its schedules.

List each obligation as: party, what must be done, by when or how often, clause number, and what happens if missed. Include payments, deliverables, reports, notices, insurance to keep, audits, price reviews, renewal and termination dates. Work out exact dates only if the contract gives a start date, and show the working. Otherwise give the rule, such as "30 days after each quarter".

Show the list and ask the person to check it. Add it to spreadsheet [[spreadsheet]], range [[range]], only when they say to, one row per obligation with six columns in the order above. Adding rows asks for approval. ${NOT_ADVICE}`,
    },
  },
];
