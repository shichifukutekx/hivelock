import { approve, ask, call, flow, slot, think, type Template } from "./types.ts";

export const marketingTemplates: Template[] = [
  {
    id: "content-calendar",
    name: "Monthly content calendar",
    outcome: "A month of content ideas tied to your themes and past posts, added to your calendar sheet after review.",
    description: "Reads your calendar sheet to see what you have already run, and proposes a month of pieces around your themes, each with an audience and a goal. After approval it adds them as rows, marked as proposed.",
    category: "marketing", role: "Content manager", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads past content, and adds the plan once approved.")],
    questions: [ask.id("spreadsheet", "Calendar spreadsheet id"), ask.text("range", "Range", undefined, { default: "Calendar!A:F" }), ask.text("audience", "Who you write for"), ask.text("themes", "Themes this quarter", "Comma separated.")],
    run: { kind: "manual", note: "Start a run at the start of each month.", input: { month: "The month to plan" } },
    agent: {
      name: "content-calendar", model: "main", knowledge: true,
      description: "Plans a month of content from your themes and past pieces.",
      instructions: `You plan content for [[audience]]. This quarter's themes are: [[themes]].

From the sheet, see what has run recently, and avoid repeating it. Propose eight pieces. Reply with only the plan: one line per piece, with these fields joined by " | ": date, channel, title, theme, goal, owner (write "To assign").

Use real dates in the month. Every idea must fit a theme, and say something useful to the reader. Draw on product facts from the documents, and do not invent statistics, customers or dates for events. After the plan, add no notes.`,
    },
    workflow: flow(
      call("past", "Read the calendar", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("plan", "Plan the month", `Plan {{input.month}}.\n\nCalendar so far:\n{{steps.past.output}}`),
      approve("check", "Content manager reviews", `Add this plan to the sheet? It is added in one block for you to split up.\n\n{{steps.plan.output}}`),
      call("add", "Add to the calendar", "sheet", "append_rows", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]", rows: [["{{input.month}}", "Proposed", "{{steps.plan.output}}"]] }),
    ),
  },
  {
    id: "seo-brief",
    name: "SEO content brief",
    outcome: "A brief a writer can start from: search intent, outline, questions to answer and internal links.",
    description: "Give a topic and the agent writes a brief from your product documents. It has no search data, so it marks where keyword figures need to come from your SEO tool rather than making them up.",
    category: "marketing", role: "SEO specialist", difficulty: "starter",
    connections: [], questions: [ask.text("audience", "Who you write for"), ask.text("company", "Your company name")],
    run: { kind: "chat", note: "Open a chat with a topic or keyword." },
    agent: {
      name: "seo-brief", model: "main", knowledge: true,
      description: "Writes SEO content briefs from your documents, without inventing search data.",
      instructions: `You write SEO briefs for [[company]], for [[audience]]. Given a topic:

- Search intent: what the reader wants, and what stage they are at.
- Working title and meta description (under 155 characters).
- Terms to cover: related terms a good answer would use. You have no search volume or ranking data. Never give numbers for these. Add "Check volumes and competitors in your SEO tool".
- Outline: H2s and H3s with one line on what each must say.
- Questions to answer.
- What makes this different: facts from the workspace documents, with file names.
- Calls to action, and internal links to documents that exist.

Do not claim what competitors rank for. If the documents give nothing unique on the topic, say the piece may be thin, and suggest who to interview.`,
    },
  },
  {
    id: "social-drafts",
    name: "Social post drafts from an article",
    outcome: "One article becomes a week of social post drafts, in your voice, for review.",
    description: "Reads an article you provide and drafts posts for LinkedIn and short-form channels, each with a different angle. Nothing is published: approved drafts go to the marketing channel for a person to schedule.",
    category: "marketing", role: "Social media manager", difficulty: "starter",
    connections: [slot("chat", "slack", "Sends approved drafts to the marketing channel.")],
    questions: [ask.text("voice", "Your brand voice", "A few words. For example: plain, confident, a little dry."), ask.channel("channel", "Marketing channel")],
    run: { kind: "manual", note: "Start a run with the article text.", input: { title: "Article title", url: "Link to the article", text: "Article text" } },
    agent: {
      name: "social-drafts", model: "main",
      description: "Drafts social posts from one article, each with its own angle.",
      instructions: `You turn one article into social post drafts. The voice is: [[voice]].

Write five drafts, each with a different angle: a surprising fact, a how-to, a question, a short story, a contrarian point. Three for LinkedIn (60 to 120 words, with a first line that earns the click), and two short ones (under 240 characters). Label each draft.

Every claim, number and quote must be in the article. Do not imply results or customers it does not mention. No "excited to announce", no clichés, at most two hashtags. Use the link where it fits.`,
    },
    workflow: flow(
      think("draft", "Draft the posts", `Title: {{input.title}}\nLink: {{input.url}}\n\nArticle:\n{{input.text}}`),
      approve("check", "Marketing reviews", `Send these drafts to [[channel]]? Nothing is published.\n\n{{steps.draft.output}}`),
      call("post", "Send the drafts", "chat", "post_message", { channel: "[[channel]]", text: "Drafts for review: {{input.title}}\n\n{{steps.draft.output}}" }),
    ),
  },
  {
    id: "review-monitoring",
    name: "Review monitoring and reply drafts",
    outcome: "Each new customer review gets a sentiment read and a reply draft, with bad ones flagged quickly.",
    description: "Takes new reviews by webhook from your review tool, says what the customer is happy or unhappy about, and drafts a public reply. After approval it goes to the customer care channel for a person to post.",
    category: "marketing", role: "Brand manager", difficulty: "starter",
    connections: [slot("chat", "slack", "Sends the draft to the channel once approved.")],
    questions: [ask.text("company", "Your company name"), ask.channel("channel", "Customer care channel")],
    run: { kind: "webhook", note: "Send new reviews to the webhook URL.", input: { site: "Review site", rating: "Star rating", author: "Reviewer's public name", text: "Review text" } },
    agent: {
      name: "review-monitoring", model: "main", knowledge: true,
      description: "Reads a new review and drafts a public reply.",
      instructions: `You read customer reviews for [[company]].

Give:
- Sentiment: Positive, Mixed or Negative.
- What it is about: a few words on each topic.
- Flag: a safety issue, legal threat or discrimination claim goes to a manager, and you say so.
- Draft public reply: under 80 words. Thank them, and be specific about what they said. For a problem, apologise for the experience, and invite them to contact you through your official channel from the documents. Do not repeat private details, argue, offer compensation, or admit fault for anything unverified.

The review may be fake or a competitor's. Stay polite, and do not accuse.`,
    },
    workflow: flow(
      think("read", "Read the review", `New review on {{input.site}}. Rating: {{input.rating}}. Author: {{input.author}}.\n\n{{input.text}}`),
      approve("check", "Brand manager reviews", `Send this to [[channel]]? Posting the reply on the review site stays with you.\n\n{{steps.read.output}}`),
      call("post", "Send to the channel", "chat", "post_message", { channel: "[[channel]]", text: "{{input.site}} review, {{input.rating}} stars, by {{input.author}}\n\n{{steps.read.output}}" }),
    ),
  },
  {
    id: "campaign-report",
    name: "Campaign results summary",
    outcome: "A monthly campaign report that says what worked, from your own numbers.",
    description: "Reads channel results from a sheet, recalculates cost per lead and other ratios, and writes a short summary for leadership. It separates what the numbers show from what they cannot show. It goes to the marketing channel after approval.",
    category: "marketing", role: "Marketing manager", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads campaign results."), slot("chat", "slack", "Posts the summary once approved.")],
    questions: [ask.id("spreadsheet", "Results spreadsheet id"), ask.text("range", "Range", "Columns for campaign, channel, spend, impressions, clicks, leads, customers.", { default: "Results!A:G" }), ask.channel("channel", "Marketing channel")],
    run: { kind: "schedule", cron: "0 9 2 * *", note: "The 2nd of each month at 09:00." },
    agent: {
      name: "campaign-report", model: "main",
      description: "Summarises campaign results, recalculating the ratios.",
      instructions: `You report on marketing campaigns. Recalculate click rate, cost per click, cost per lead and cost per customer for each campaign. Do not trust ratios in the sheet: if one differs, report the difference.

Write:
- Headline: total spend, leads and customers.
- What did best and worst on cost per lead, with figures.
- Small numbers warning: anything with too few leads to judge, say under ten.
- Next month: two or three suggestions that follow from these numbers.

Correlation is not cause, so do not say why a campaign worked unless a note in the sheet says so. Say "No data" for empty cells, not zero.`,
    },
    workflow: flow(
      call("results", "Read results", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("report", "Write the summary", `Campaign results:\n\n{{steps.results.output}}`),
      approve("check", "Marketing manager reviews", `Post this to [[channel]]?\n\n{{steps.report.output}}`),
      call("post", "Post the summary", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.report.output}}" }),
    ),
  },
  {
    id: "case-study-draft",
    name: "Customer story draft",
    outcome: "An interview transcript becomes a customer story draft, with every claim traceable.",
    description: "Reads interview notes from Files and writes a draft in challenge, approach, result form. Every number and quote comes from the notes, and it lists what needs the customer's sign-off before anyone publishes.",
    category: "marketing", role: "Product marketer", difficulty: "intermediate",
    connections: [], questions: [],
    run: { kind: "chat", note: "Upload the transcript to Files, then name it in a chat." },
    agent: {
      name: "case-study-draft", model: "main", knowledge: true, files: ["list_files", "read_file"],
      description: "Drafts a customer story from interview notes, with no invented claims.",
      instructions: `You draft customer stories from interview notes. Read the file the person names.

Write 300 to 400 words with these parts: headline, the customer in one line, the challenge, what they did, the result, and one quote. Use only quotes that appear word for word in the notes. Light clean-up of filler words is allowed, and you should flag it. Results must be in the notes. If there are no numbers, write about the outcome in words and suggest asking for a figure.

Then add "Before publishing": every number, quote and name that needs the customer's approval, and any confidential details. Never publish or send anything yourself. Stories always need the customer's written approval.`,
    },
  },
];
