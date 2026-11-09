import { approve, ask, call, flow, slot, think, type Template } from "./types.ts";

export const executiveTemplates: Template[] = [
  {
    id: "daily-digest",
    name: "Daily leadership digest",
    outcome: "One short morning note on what happened and what needs a decision, from your busiest channels.",
    description: "Reads a key Slack channel and your urgent Zendesk tickets, and writes a two-minute morning note. After approval it is emailed to you.",
    category: "executive", role: "Chief executive", difficulty: "starter",
    connections: [slot("chat", "slack", "Reads the channel."), slot("desk", "zendesk", "Reads urgent open tickets."), slot("mail", "email", "Emails the digest once approved.")],
    questions: [ask.channel("channel", "Channel to read"), ask.email("to", "Send the digest to")],
    run: { kind: "schedule", cron: "30 7 * * 1-5", note: "Weekdays at 07:30." },
    agent: {
      name: "daily-digest", model: "main",
      description: "Writes a short morning digest from channels and tickets.",
      instructions: `You write a morning note for a busy leader. The goal is that they can skip the channels. Under 200 words.

Sections:
- Needs you: anything that asks for a leader's decision, with who is waiting.
- Going wrong: outages, unhappy customers, missed dates.
- Going right: one or two wins, if real.
- Quiet today: leave this out if there is news.

Choose by impact, not volume. Use names and numbers from the messages. Do not include small talk, or draw conclusions about a person's performance. If there was nothing important, say so in one line. Quiet days are good news.`,
    },
    workflow: flow(
      call("messages", "Read the channel", "chat", "list_messages", { channel: "[[channel]]", limit: 100 }),
      call("tickets", "Read urgent tickets", "desk", "search", { query: "type:ticket status<solved priority:urgent", limit: 25 }),
      think("note", "Write the digest", `Channel messages:\n{{steps.messages.output}}\n\nUrgent tickets:\n{{steps.tickets.output}}`),
      approve("check", "Confirm before sending", `Send this digest to [[to]]?\n\n{{steps.note.output}}`),
      call("send", "Email the digest", "mail", "send", { to: "[[to]]", subject: "Daily digest", text: "{{steps.note.output}}" }),
    ),
  },
  {
    id: "weekly-business-digest",
    name: "Weekly business review",
    outcome: "Sales, support and delivery on one page, every Friday.",
    description: "Pulls open deals from HubSpot, tickets from Zendesk and issues from Jira, and writes one page on how the week went across the business. After approval it goes to the leadership channel.",
    category: "executive", role: "Chief operating officer", difficulty: "advanced",
    connections: [slot("crm", "hubspot", "Reads deals."), slot("desk", "zendesk", "Reads this week's tickets."), slot("tracker", "jira", "Reads delivery work."), slot("chat", "slack", "Posts the review once approved.")],
    questions: [ask.id("project", "Jira project key"), ask.channel("channel", "Leadership channel")],
    run: { kind: "schedule", cron: "0 14 * * 5", note: "Fridays at 14:00." },
    agent: {
      name: "weekly-business-digest", model: "main",
      description: "Writes a one-page weekly review across sales, support and delivery.",
      instructions: `You write a one-page weekly business review from CRM deals, support tickets and delivery issues.

For each of Sales, Support and Delivery, write: what happened (with counts and amounts from the data), what is at risk, and what needs a decision. Then give "Top three this week" across the whole business.

Give counts only from the data supplied, and say if a list hit its limit. You have only this week's snapshot, so make no comparison with last week. Say nothing on individual performance. Add no forecast, and if a section has no data, say so.`,
    },
    workflow: flow(
      call("deals", "Read deals", "crm", "search", { objectType: "deals", query: "", limit: 100 }),
      call("tickets", "Read tickets", "desk", "search", { query: "type:ticket created>7days", limit: 100 }),
      call("issues", "Read delivery issues", "tracker", "search", { jql: "project = [[project]] AND updated >= -7d ORDER BY priority DESC", limit: 100 }),
      think("review", "Write the review", `Deals:\n{{steps.deals.output}}\n\nTickets:\n{{steps.tickets.output}}\n\nDelivery issues:\n{{steps.issues.output}}`),
      approve("check", "Confirm before posting", `Post this to [[channel]]?\n\n{{steps.review.output}}`),
      call("post", "Post the review", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.review.output}}" }),
    ),
  },
  {
    id: "meeting-notes-to-actions",
    name: "Meeting notes to actions",
    outcome: "Every meeting ends with clear decisions and owned actions, shared the same day.",
    description: "Paste the notes or transcript. The agent pulls out decisions, actions with owners and dates, and open questions, and marks anything unassigned. After approval it posts to the team channel.",
    category: "executive", role: "Chief of staff", difficulty: "starter",
    connections: [slot("chat", "slack", "Posts the summary once approved.")],
    questions: [ask.channel("channel", "Team channel")],
    run: { kind: "manual", note: "Start a run after the meeting.", input: { meeting: "Meeting name and date", notes: "Notes or transcript" } },
    agent: {
      name: "meeting-notes-to-actions", model: "fast",
      description: "Pulls decisions, actions and open questions out of meeting notes.",
      instructions: `You turn meeting notes into follow-ups.

Write:
- Decisions: only things clearly agreed. Something discussed is not decided.
- Actions: what, who and by when. If nobody was named, write "Owner needed". If no date, write "Date needed".
- Open questions: raised but not settled.
- Summary: two sentences at the top.

Do not assign an owner because someone spoke about a topic. Leave out personal remarks, and anything marked off the record. Keep the wording neutral. A transcript may be wrong, so mark names or figures that look garbled.`,
    },
    workflow: flow(
      think("actions", "Pull out the actions", `Meeting: {{input.meeting}}\n\nNotes:\n{{input.notes}}`),
      approve("check", "Meeting owner reviews", `Post this to [[channel]]?\n\n{{steps.actions.output}}`),
      call("post", "Post the summary", "chat", "post_message", { channel: "[[channel]]", text: "{{input.meeting}}\n\n{{steps.actions.output}}" }),
    ),
  },
  {
    id: "kpi-report",
    name: "Monthly KPI report",
    outcome: "Your KPIs against target, with what changed, drawn straight from your KPI sheet.",
    description: "Reads your KPI sheet and reports each measure against target and last month, marking which are off track. It asks the owner for reasons rather than inventing them. It goes to the leadership channel after approval.",
    category: "executive", role: "Chief financial officer", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads the KPI sheet."), slot("chat", "slack", "Posts the report once approved.")],
    questions: [ask.id("spreadsheet", "KPI spreadsheet id"), ask.text("range", "Range", "Columns for KPI, owner, target, last month, this month, higher is better.", { default: "KPIs!A:F" }), ask.channel("channel", "Leadership channel")],
    run: { kind: "schedule", cron: "0 8 3 * *", note: "The 3rd of each month at 08:00." },
    agent: {
      name: "kpi-report", model: "main", humanDecides: true,
      description: "Reports KPIs against target and marks those off track.",
      instructions: `You write the monthly KPI report. For each KPI, compare this month with target and with last month. Use the column saying whether higher is better. Status is On track, Watch (within 5 percent of target) or Off track.

Write:
- Summary: how many are on track, on watch and off track.
- Off track: KPI, value, target, gap, owner, and a question for the owner.
- Watch: one line each.
- On track: a count, and any big improvement.

Blank values mean "No data", not zero. Do not explain causes. The sheet does not say why, so ask.`,
    },
    workflow: flow(
      call("kpis", "Read the KPI sheet", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("report", "Write the report", `KPI data:\n\n{{steps.kpis.output}}`),
      approve("check", "Confirm before posting", `Post this to [[channel]]?\n\n{{steps.report.output}}`),
      call("post", "Post the report", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.report.output}}" }),
    ),
  },
  {
    id: "board-update-draft",
    name: "Board update draft",
    outcome: "A first draft of the board update from your own documents, with the gaps made plain.",
    description: "Name the period and the agent drafts a board update from your reports and notes: highlights, numbers, risks and the asks of the board. Unsupported statements are left out, and listed gaps go to you to fill in.",
    category: "executive", role: "Chief executive", difficulty: "intermediate",
    connections: [], questions: [ask.text("company", "Your company name")],
    run: { kind: "chat", note: "Upload the period's reports to the documents, then name the period." },
    agent: {
      name: "board-update-draft", model: "main", knowledge: true, files: ["list_files", "read_file"], humanDecides: true,
      description: "Drafts a board update from workspace documents, showing what is missing.",
      instructions: `You draft board updates for [[company]]. Use the workspace documents and any files the person names.

Sections: Summary (five lines), Highlights, Financials, Customers, People, Risks, Asks of the board. Every number has a source file. If documents disagree, show both and flag it.

Be straight about bad news: a board trusts a report that includes it. Keep to what the documents show. Leave out forecasts and judgements on people unless a document states them. Where a section lacks sources, write "To be added" and list exactly what is needed under "Gaps for you to fill".`,
    },
  },
  {
    id: "decision-log",
    name: "Decision log keeper",
    outcome: "Decisions made in chat get recorded in Notion, with who, why and when.",
    description: "Reads a Slack channel and picks out what was decided, with the reason and the people involved. After approval it appends them to your decision log page, so the reason is still there in a year.",
    category: "executive", role: "Chief of staff", difficulty: "starter",
    connections: [slot("chat", "slack", "Reads the channel."), slot("docs", "notion", "Adds to the log page once approved.")],
    questions: [ask.channel("channel", "Channel to read"), ask.id("page", "Notion decision log page id")],
    run: { kind: "schedule", cron: "0 17 * * 5", note: "Fridays at 17:00." },
    agent: {
      name: "decision-log", model: "fast",
      description: "Finds decisions in channel messages and writes them up for the log.",
      instructions: `You keep a decision log. From channel messages, list what was really decided: agreed by someone with the say, not just suggested. For each one give the date, the decision in one sentence, the reason, as stated, the people involved, and a link or timestamp for the message.

If it is unclear whether something was decided, put it under "Possibly decided, please confirm". If no reason was stated, write "Not stated". If there were no decisions, say so.`,
    },
    workflow: flow(
      call("messages", "Read the channel", "chat", "list_messages", { channel: "[[channel]]", limit: 200 }),
      think("log", "Find the decisions", `Channel messages:\n\n{{steps.messages.output}}`),
      approve("check", "Confirm before adding", `Add this to the decision log?\n\n{{steps.log.output}}`),
      call("add", "Add to the log", "docs", "append_text", { pageId: "[[page]]", text: "{{steps.log.output}}" }),
    ),
  },
];
