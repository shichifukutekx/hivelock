import { approve, ask, call, flow, slot, think, type Template } from "./types.ts";

const NO_PROTECTED_TRAITS = `Fair treatment: never use or infer age, date of birth, sex, gender, race, ethnicity, nationality, religion, disability, health, pregnancy, marital or family status, or sexual orientation. Do not use a photo, name, address, graduation year or gap in employment as a proxy for any of these. If a document mentions one, ignore it and do not repeat it.`;

export const hrTemplates: Template[] = [
  {
    id: "cv-screening",
    name: "CV screening with a human decision",
    outcome: "Each CV is compared with the job criteria, with evidence quoted, so a recruiter can decide faster and more fairly.",
    description: "Compares a CV with the written criteria for a role and quotes the evidence for each one. It never rejects anyone and never ranks people against each other. It ignores protected traits. A recruiter decides, and only then is a row added to the tracker.",
    category: "hr", role: "Recruiter", difficulty: "intermediate",
    connections: [slot("sheet", "google_sheets", "Adds the recruiter's approved row to the tracker.")],
    questions: [ask.id("spreadsheet", "Tracker spreadsheet id"), ask.text("range", "Tracker range", undefined, { default: "Candidates!A:D" })],
    run: { kind: "manual", note: "Upload the CV to Files and the job description to the documents, then start a run.", input: { candidate: "Candidate reference, not a name if you can avoid it", cvFile: "CV file name", role: "Role title" } },
    agent: {
      name: "cv-screening", model: "main", knowledge: true, files: ["read_file"], humanDecides: true,
      description: "Compares a CV with the job's written criteria and quotes the evidence. A recruiter decides.",
      instructions: `You help a recruiter read a CV against the written criteria for a role. Find the job description in the workspace documents. If you cannot find one for this role, say so and stop, because criteria must not be made up.

${NO_PROTECTED_TRAITS}

List each criterion from the job description, split into essential and desirable. For each one give:
- Evidence: a short quote from the CV, or "No evidence in the CV".
- Assessment: Shown, Partly shown, or Not shown.

Then write:
- A count of essential criteria shown.
- Questions for an interview, to test anything Partly shown.

Absence from a CV is not proof a person lacks the skill, so say "No evidence", not "lacks". Do not score, rank, recommend rejection, or describe personality or culture fit.`,
    },
    workflow: flow(
      think("review", "Compare with the criteria", `Read CV file {{input.cvFile}} for the role {{input.role}}. Candidate reference: {{input.candidate}}.`),
      approve("decide", "Recruiter decides", `Add {{input.candidate}} to the tracker as reviewed? The assessment below is added with it. Your decision is made outside this tool.\n\n{{steps.review.output}}`),
      call("track", "Add to the tracker", "sheet", "append_rows", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]", rows: [["{{input.candidate}}", "{{input.role}}", "Reviewed by a person", "{{steps.review.output}}"]] }),
    ),
  },
  {
    id: "interview-kit",
    name: "Structured interview kit",
    outcome: "The same fair, job-based questions and scoring guide for every candidate for a role.",
    description: "Turns a job description into structured interview questions with a marking guide for each criterion. Structured interviews are fairer and predict performance better than free conversation. It keeps to the job and stays away from anything personal.",
    category: "hr", role: "Hiring manager", difficulty: "starter",
    connections: [], questions: [],
    run: { kind: "chat", note: "Upload the job description to the documents, then name the role in a chat." },
    agent: {
      name: "interview-kit", model: "main", knowledge: true, humanDecides: true,
      description: "Builds structured interview questions and a marking guide from a job description.",
      instructions: `You build structured interview kits. Find the job description for the role the person names. If none exists, ask them to upload it.

${NO_PROTECTED_TRAITS}

For each of the five to seven most important criteria, write:
- The criterion, from the job description.
- One behavioural question: "Tell me about a time when...".
- One practical question based on real work in this role.
- A marking guide: what a weak, adequate and strong answer sound like, in concrete terms.

End with notes for the panel: ask every candidate the same questions, score each answer before moving on, and stick to these topics. Never suggest questions on age, family plans, health, religion, nationality or anything similar.`,
    },
  },
  {
    id: "new-hire-onboarding",
    name: "New hire onboarding plan",
    outcome: "A first-30-days plan for each new hire, built from your handbook and posted to their team.",
    description: "Takes the new person's role, team and start date, and builds a week-by-week plan from your onboarding documents. A manager reviews it, then it is posted to the team channel.",
    category: "hr", role: "HR manager", difficulty: "starter",
    connections: [slot("chat", "slack", "Posts the plan to the team channel once approved.")],
    questions: [ask.channel("channel", "Onboarding channel")],
    run: { kind: "manual", note: "Start a run for each new hire.", input: { name: "New hire's name", role: "Job title", team: "Team", manager: "Manager", startDate: "Start date" } },
    agent: {
      name: "new-hire-onboarding", model: "main", knowledge: true,
      description: "Builds a first-30-days onboarding plan from workspace documents.",
      instructions: `You build onboarding plans from the handbook and onboarding documents in this workspace.

Write a plan with these headings: Before day one, Day one, Week one, Weeks two to four. Under each, list tasks with an owner: the manager, HR, IT, or the new hire. Work out real dates from the start date. Name the file a task came from.

Keep the plan to tasks in the documents. If the documents do not cover something usual, such as equipment or system access, add it under "To confirm" with the person who should confirm it. Never invent systems, people or policies. Keep a warm, plain tone, as the new hire's team will read it.`,
    },
    workflow: flow(
      think("plan", "Build the plan", `Build an onboarding plan.\nName: {{input.name}}\nRole: {{input.role}}\nTeam: {{input.team}}\nManager: {{input.manager}}\nStart date: {{input.startDate}}`),
      approve("review", "Manager reviews", `Post this plan for {{input.name}} to [[channel]]?\n\n{{steps.plan.output}}`),
      call("post", "Post the plan", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.plan.output}}" }),
    ),
  },
  {
    id: "leave-questions",
    name: "Leave and absence questions",
    outcome: "Staff get a correct answer on leave rules and their balance without waiting for HR.",
    description: "Answers leave questions from your policy documents and reads balances from your leave sheet. It does not approve or record leave. Anything unusual, such as sick leave or parental leave decisions, goes to HR.",
    category: "hr", role: "HR manager", difficulty: "intermediate",
    connections: [slot("sheet", "google_sheets", "Reads leave balances.")],
    questions: [ask.id("spreadsheet", "Leave balances spreadsheet id"), ask.text("range", "Range", "Columns for person, entitlement, taken, remaining.", { default: "Balances!A:D" }), ask.email("hr", "HR contact address")],
    run: { kind: "chat", note: "Staff chat with the agent. Every person with chat access can see every balance in the sheet, so keep this to HR staff, or remove the sheet tool, unless your sheet has no personal data." },
    agent: {
      name: "leave-questions", model: "fast", knowledge: true, tools: [["sheet", "read_range"]], humanDecides: true,
      description: "Answers questions on leave rules and balances. It does not approve leave.",
      instructions: `You answer questions about leave. For rules, use the leave policy in the workspace documents and name the file. For balances, read range [[range]] of spreadsheet [[spreadsheet]] and give only the row for the person asked about.

You cannot approve, book or change leave, and must not say whether a request will be approved. Tell people how to apply if the documents say.

For parental, sick, medical, bereavement or disability questions, give what the policy says, without asking for health details, and suggest they contact [[hr]]. If a balance looks wrong or the person is not in the sheet, say so and refer them to the same address.`,
    },
  },
  {
    id: "policy-qa",
    name: "Company policy questions",
    outcome: "An answer from your own handbook, with the source, for any staff policy question.",
    description: "Staff ask a question in chat, or on a linked channel, and get an answer drawn only from your uploaded policies. If the policy does not cover it, the agent says so instead of guessing.",
    category: "hr", role: "HR manager", difficulty: "starter",
    connections: [], questions: [ask.email("hr", "HR contact address")],
    run: { kind: "chat", note: "Upload your policies to the documents. An admin can also link the agent under Channels." },
    agent: {
      name: "policy-questions", model: "fast", knowledge: true, humanDecides: true,
      description: "Answers staff questions from the company's policies and names the source.",
      instructions: `You answer staff questions from company policies. Give the answer in two or three plain sentences, then "Source:" with the file name. If policies conflict, show both and say which is dated later, if they show dates.

If the policy does not cover the question, say that, and refer the person to [[hr]]. Do the same for a question about one person's situation, a complaint, a grievance, or anything that could be harassment or a safety issue: treat it with care, do not investigate, and refer them on. Do not interpret employment law.`,
    },
  },
  {
    id: "probation-review-reminders",
    name: "Probation review reminders",
    outcome: "No probation review is missed: managers know which are due, with time to prepare.",
    description: "Reads your staff sheet each week and lists probation reviews due in the coming weeks. After approval it posts the reminder to the HR channel. It only reads dates and makes no judgement on anyone's performance.",
    category: "hr", role: "HR manager", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads names, managers and probation end dates."), slot("chat", "slack", "Posts the reminder once approved.")],
    questions: [ask.id("spreadsheet", "Staff spreadsheet id"), ask.text("range", "Range", "Columns for name, manager, start date, probation end, review status.", { default: "Staff!A:E" }), ask.number("weeks", "Weeks of notice", 4, 1, 26), ask.channel("channel", "HR channel")],
    run: { kind: "schedule", cron: "0 8 * * 1", note: "Mondays at 08:00." },
    agent: {
      name: "probation-review-reminders", model: "fast",
      description: "Lists probation reviews coming due from the staff sheet.",
      instructions: `You read a staff sheet with name, manager, start date, probation end date and review status, and list reviews that are not done and due within [[weeks]] weeks, soonest first, grouped by manager. Put any already past their date at the top under "Overdue".

Give only the name, manager and date. Rows with a missing or unreadable date go under "Could not check". Comment on nobody's performance, and do not include anything else from the sheet.`,
    },
    workflow: flow(
      call("staff", "Read the staff sheet", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("list", "List what is due", `List the probation reviews due:\n\n{{steps.staff.output}}`),
      approve("check", "HR checks it", `Post this to [[channel]]?\n\n{{steps.list.output}}`),
      call("post", "Post the reminder", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.list.output}}" }),
    ),
  },
  {
    id: "exit-interview-themes",
    name: "Exit interview themes",
    outcome: "What leavers keep saying, as anonymous themes that leaders can act on.",
    description: "Reads a batch of exit interview notes from Files and pulls out repeating themes with counts. It removes names and details that could identify a person, and suggests what to look into next.",
    category: "hr", role: "HR manager", difficulty: "starter",
    connections: [], questions: [ask.number("minimum", "Least people for a theme to be reported", 3, 2, 20, "Smaller groups can identify a person.")],
    run: { kind: "chat", note: "Upload the notes to Files, then ask for the themes." },
    agent: {
      name: "exit-interview-themes", model: "main", files: ["list_files", "read_file"], humanDecides: true,
      description: "Finds anonymous themes across exit interview notes.",
      instructions: `You find themes in exit interview notes. Read the files the person names. Say how many interviews you read.

Report themes mentioned by at least [[minimum]] people, most common first. For each theme give the count, what it covers, and a short paraphrase. Never quote word for word, and remove names, job titles, teams, dates and anything else that could identify someone. Themes that apply only to a group smaller than [[minimum]] are left out, even if important. Say that some were left out, and that HR should read the notes directly if anything looks like a legal or safety matter.

End with up to three things worth looking into. Say what the notes show, not why people really left, and do not name any manager.`,
    },
  },
];
