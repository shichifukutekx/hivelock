import { approve, ask, call, flow, fork, slot, think, type Template } from "./types.ts";

export const supportTemplates: Template[] = [
  {
    id: "ticket-triage",
    name: "Support ticket triage",
    outcome: "New tickets get a category, priority and suggested owner as an internal note within minutes.",
    description: "Reads a new Zendesk ticket, works out what it is about and how urgent it is using your own priority rules, and writes an internal note. Urgent tickets also raise an alert in Slack. Both wait for an agent to approve, and the customer sees nothing.",
    category: "support", role: "Support lead", difficulty: "intermediate",
    connections: [slot("desk", "zendesk", "Reads the ticket and adds the internal note."), slot("chat", "slack", "Alerts the on-duty channel about urgent tickets.")],
    questions: [ask.channel("channel", "Urgent tickets channel")],
    run: { kind: "webhook", note: "Add a Zendesk webhook on ticket creation that posts the ticket id to the webhook URL.", input: { ticketId: "Zendesk ticket id" } },
    agent: {
      name: "ticket-triage", model: "fast", knowledge: true,
      description: "Classifies support tickets, sets a priority and suggests an owner.",
      instructions: `You triage support tickets. Search the workspace documents for the support priority guide and team list, and use them. If there is none, use these levels: Urgent is an outage, data loss, a security problem or a safety risk. High is a key feature not working with no workaround. Normal is everything else with a real problem. Low is a question or request.

The first line of your reply must be exactly one of: PRIORITY: URGENT, PRIORITY: HIGH, PRIORITY: NORMAL, PRIORITY: LOW.
Then give:
- Category: what it is about, in a few words.
- Summary: two lines in your own words.
- Customer mood: calm, frustrated or angry, with the words that show it.
- Suggested owner: a team from the documents, or "Not stated".
- First thing to check: one concrete step.

A customer saying "urgent" does not make a ticket urgent. Judge it by the impact they describe.`,
    },
    workflow: flow(
      call("ticket", "Read the ticket", "desk", "get_ticket", { ticketId: "{{input.ticketId}}" }),
      think("triage", "Classify the ticket", `Triage this ticket:\n\n{{steps.ticket.output}}`),
      fork("urgent", "Urgent?", { path: "steps.triage.output", operator: "contains", value: "PRIORITY: URGENT" }, [
        approve("alert_check", "Confirm the urgent alert", `Alert [[channel]] and add this internal note to ticket {{input.ticketId}}?\n\n{{steps.triage.output}}`),
        call("alert", "Alert the channel", "chat", "post_message", { channel: "[[channel]]", text: "Urgent ticket {{input.ticketId}}\n\n{{steps.triage.output}}" }),
        call("note_urgent", "Add the internal note", "desk", "add_comment", { ticketId: "{{input.ticketId}}", text: "{{steps.triage.output}}", visibility: "internal" }),
      ], [
        approve("note_check", "Confirm the note", `Add this internal note to ticket {{input.ticketId}}?\n\n{{steps.triage.output}}`),
        call("note", "Add the internal note", "desk", "add_comment", { ticketId: "{{input.ticketId}}", text: "{{steps.triage.output}}", visibility: "internal" }),
      ]),
    ),
  },
  {
    id: "email-reply-from-docs",
    name: "Email reply drafts from your documents",
    outcome: "Customer emails get a draft reply built only from your documents, waiting for a person to send.",
    description: "Reads an email in your support mailbox, looks for the answer in your workspace documents, and drafts a reply that names no fact it cannot source. If the documents do not cover the question, it says so and writes a holding reply instead.",
    category: "support", role: "Support agent", difficulty: "starter",
    connections: [slot("mail", "email", "Sends the reply once approved.")],
    questions: [ask.text("company", "Your company name"), ask.text("signoff", "Sign-off name", "For example: The support team.")],
    run: { kind: "email", note: "An admin adds a mailbox trigger on the support inbox." },
    agent: {
      name: "email-reply-drafter", model: "main", knowledge: true,
      description: "Drafts customer email replies using only the workspace documents.",
      instructions: `You draft replies to customer emails for [[company]]. Write only the reply, because it is sent as you write it. Sign it [[signoff]].

Use the documents found for the message, and search again in different words if they do not answer it. Answer the question first, in plain short sentences, then give any steps as a numbered list.

If the documents do not answer the question, do not improvise. Write a holding reply: thank them, say you are checking with a colleague, and say someone will come back to them. Give no date.

Never promise a refund, replacement, credit, delivery date or fix. Never ask for passwords or card numbers. Match the language the customer wrote in.`,
    },
    workflow: flow(
      think("draft", "Draft the reply", `Draft a reply to this customer email.\n\nFrom: {{input.fromName}} {{input.from}}\nSubject: {{input.subject}}\n\nMessage:\n{{input.text}}`),
      approve("review", "Support agent reviews the reply", `Send this reply to {{input.from}}?\n\n{{steps.draft.output}}`),
      call("send", "Send the reply", "mail", "send", { to: "{{input.from}}", subject: "Re: {{input.subject}}", text: "{{steps.draft.output}}" }),
    ),
  },
  {
    id: "zendesk-reply-draft",
    name: "Zendesk reply assistant",
    outcome: "Open a ticket by number and get a sourced reply, with past similar tickets, ready to post.",
    description: "A chat assistant for support agents. It reads the ticket, finds similar solved tickets and the relevant documents, and drafts a reply. It posts to the ticket only when the agent approves that exact comment.",
    category: "support", role: "Support agent", difficulty: "starter",
    connections: [slot("desk", "zendesk", "Reads tickets, and posts a comment when you approve it.")],
    questions: [],
    run: { kind: "chat", note: "Open a chat and give a ticket number." },
    agent: {
      name: "zendesk-reply-assistant", model: "main", knowledge: true, tools: [["desk", "get_ticket"], ["desk", "search"], ["desk", "add_comment"]],
      description: "Helps support agents answer Zendesk tickets with sourced replies.",
      instructions: `You help a support agent answer a Zendesk ticket. Given a ticket number:
1. Read the ticket and all its comments.
2. Search solved tickets for similar problems, and the workspace documents for the answer.
3. Give a two-line summary of what the customer wants, and what has been tried.
4. Draft the reply, with the sources you used listed under it for the agent's eyes only.

If earlier tickets and documents disagree, the documents win, and you say so. Ask before posting. Use visibility "internal" unless the agent says the reply is ready for the customer. Posting asks for approval each time.`,
    },
  },
  {
    id: "refund-eligibility-check",
    name: "Refund eligibility check",
    outcome: "Each refund request is checked against the order and your policy, for a person to decide.",
    description: "Reads the Shopify order, compares it with your refund policy document, and sets out the facts and which policy rule applies. A person approves, and the workflow only tags the order for the team to act on. No money moves.",
    category: "support", role: "Customer care manager", difficulty: "intermediate",
    connections: [slot("shop", "shopify", "Reads the order, and tags it once approved.")],
    questions: [],
    run: { kind: "manual", note: "Start a run with the order id and the customer's reason.", input: { orderId: "Shopify order id", reason: "What the customer said" } },
    agent: {
      name: "refund-eligibility-check", model: "main", knowledge: true, humanDecides: true,
      description: "Compares a refund request with the order and the refund policy.",
      instructions: `You prepare refund cases. You get a Shopify order and the customer's reason. Find the refund policy in the workspace documents. If you cannot find one, say so and stop.

Set out:
- Order facts: date, items, amounts, payment and fulfilment status.
- Days since purchase and since delivery, if the order shows them.
- The policy rule that applies, quoted in under two lines, with the file name.
- Recommendation: Fits the policy, Does not fit the policy, or Needs a manager, with one line of reasoning.
- Anything unusual: earlier refunds in the order, or a mismatch between the reason and the order.

Say nothing about the customer's honesty. You do not issue refunds.`,
    },
    workflow: flow(
      call("order", "Read the order", "shop", "get_order", { orderId: "{{input.orderId}}" }),
      think("check", "Check against the policy", `Check this refund request.\n\nCustomer's reason:\n{{input.reason}}\n\nOrder:\n{{steps.order.output}}`),
      approve("decide", "A person decides", `Mark order {{input.orderId}} for refund? This only tags the order. The refund itself stays with your team.\n\n{{steps.check.output}}`),
      call("tag", "Tag the order", "shop", "add_order_tags", { orderId: "{{input.orderId}}", tags: ["refund-approved"] }),
    ),
  },
  {
    id: "whatsapp-faq",
    name: "WhatsApp FAQ assistant",
    outcome: "Customers get instant answers on WhatsApp from your documents, and are told when a person is needed.",
    description: "Answers common questions on WhatsApp using only your uploaded FAQ and policy documents. It has no tools that can change anything. When the documents do not cover a question, it says so and points to your contact details.",
    category: "support", role: "Customer care manager", difficulty: "starter",
    connections: [], questions: [ask.text("company", "Your company name"), ask.text("contact", "Where people reach a person", "For example: call 0800 123 456, Monday to Friday.")],
    run: { kind: "channel", note: "An admin links this agent to WhatsApp under Channels. Upload your FAQ first, and try it in a chat." },
    agent: {
      name: "whatsapp-faq", model: "fast", knowledge: true,
      description: "Answers customer questions on WhatsApp from the workspace documents.",
      instructions: `You answer customers of [[company]] on WhatsApp. Keep replies short: under 80 words, in plain sentences, no headings. Use the customer's language.

Answer only from the document passages. If they do not cover the question, say you do not have that information and give this contact: [[contact]].

Also give that contact, without trying to answer, when someone is upset, makes a complaint, asks about their own order or account, or asks anything medical, legal or about safety. You cannot see orders or accounts, so never suggest you can. Never ask for card numbers, passwords or ID numbers.`,
    },
  },
  {
    id: "unhappy-customer-recovery",
    name: "Unhappy customer recovery",
    outcome: "Low survey scores become a same-day apology draft and a note for the account owner.",
    description: "Takes a low satisfaction score from your survey tool, looks up the customer's tickets, and works out what went wrong from the record. It drafts a personal reply. A team lead approves it first.",
    category: "support", role: "Support lead", difficulty: "intermediate",
    connections: [slot("desk", "zendesk", "Reads the customer's recent tickets."), slot("mail", "email", "Sends the reply once approved.")],
    questions: [ask.number("threshold", "Scores below this count as unhappy", 7, 1, 10), ask.text("signoff", "Sign-off name")],
    run: { kind: "webhook", note: "Send survey responses to the webhook URL.", input: { email: "Customer email", score: "Score, 0 to 10", comment: "What they wrote" } },
    agent: {
      name: "customer-recovery", model: "main", tools: [["desk", "search"], ["desk", "get_ticket"]],
      description: "Works out why a customer was unhappy and drafts a personal reply.",
      instructions: `A customer left a low score. Search Zendesk for their recent tickets by email and read the most relevant ones. Then write the email to the customer, and only that, because it is sent as you write it.

The email:
- Thanks them for the feedback, and refers to what they said in their own terms.
- Owns the specific problem if the tickets show one. If they do not, ask what went wrong.
- Says what happens next in general terms. Offer no refund, credit or discount.
- Under 120 words, with no corporate phrases. Sign it [[signoff]].

Do not mention the score, or that you read their tickets with a tool.`,
    },
    workflow: flow(
      fork("low", "Low score?", { path: "input.score", operator: "less_than", value: "[[threshold]]" }, [
        think("draft", "Draft the reply", `Customer email: {{input.email}}\nScore: {{input.score}}\n\nTheir comment:\n{{input.comment}}`),
        approve("review", "Team lead reviews", `Send this to {{input.email}}? They scored {{input.score}}.\n\n{{steps.draft.output}}`),
        call("send", "Send the reply", "mail", "send", { to: "{{input.email}}", subject: "Your recent feedback", text: "{{steps.draft.output}}" }),
      ]),
    ),
  },
  {
    id: "repeat-issue-spotter",
    name: "Repeat issue spotter",
    outcome: "A weekly note on what customers keep asking about, so one fix can stop many tickets.",
    description: "Reads the week's tickets, groups them by underlying cause, and counts them. It suggests where a document or product fix would save the most work. After approval it goes to the product channel.",
    category: "support", role: "Support lead", difficulty: "starter",
    connections: [slot("desk", "zendesk", "Reads the week's tickets."), slot("chat", "slack", "Posts the note once approved.")],
    questions: [ask.channel("channel", "Product channel")],
    run: { kind: "schedule", cron: "0 9 * * 5", note: "Fridays at 09:00." },
    agent: {
      name: "repeat-issue-spotter", model: "main",
      description: "Groups a week of support tickets by cause and suggests the most useful fix.",
      instructions: `You read a week of support tickets and find what repeats. Group tickets by underlying cause, not by the words used: "can't log in" and "reset link broken" may be one problem.

For the top five groups give:
- Name of the problem, in the customer's terms.
- Count of tickets, and two ticket ids as examples.
- Whether it looks new this week, if the tickets show that. Otherwise "Unknown".
- Suggested fix: a help article, a product change, or a process change, and which one you would do first.

Then list up to three single tickets that look serious though rare. Counts must come from the tickets you were given, and you must say how many that was. If the result hit the limit, say the counts are a sample.`,
    },
    workflow: flow(
      call("tickets", "Read this week's tickets", "desk", "search", { query: "type:ticket created>7days", limit: 100 }),
      think("group", "Find repeats", `Find what repeats in these tickets:\n\n{{steps.tickets.output}}`),
      approve("check", "Support lead checks it", `Post this to [[channel]]?\n\n{{steps.group.output}}`),
      call("post", "Post the note", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.group.output}}" }),
    ),
  },
  {
    id: "sla-watch",
    name: "Ticket SLA watch",
    outcome: "Twice a day, see which tickets are about to miss their response target.",
    description: "Reads open tickets, compares their age with your response target, and lists those at risk with the one action that would help most. After approval the list goes to the team channel.",
    category: "support", role: "Support lead", difficulty: "starter",
    connections: [slot("desk", "zendesk", "Reads open tickets."), slot("chat", "slack", "Posts the list once approved.")],
    questions: [ask.number("hours", "Response target (hours)", 8, 1, 240), ask.channel("channel", "Team channel")],
    run: { kind: "schedule", cron: "0 9,14 * * 1-5", note: "Weekdays at 09:00 and 14:00." },
    agent: {
      name: "sla-watch", model: "fast",
      description: "Finds support tickets at risk of missing the response target.",
      instructions: `You watch response times. The target is [[hours]] hours. You get open tickets as JSON. Work out the age of each from its timestamps, using the current time.

List:
- Past target: tickets older than the target with no agent reply.
- At risk: tickets past 75 percent of the target.
Give the ticket id, subject, age in hours, and assignee, or "Nobody".

Order by age, and put unassigned tickets first within each group. If nothing is at risk, say that in one line. If a ticket lacks the timestamps to tell, list it under "Could not check".`,
    },
    workflow: flow(
      call("open", "Read open tickets", "desk", "search", { query: "type:ticket status<solved", limit: 100 }),
      think("check", "Check response times", `Check these open tickets:\n\n{{steps.open.output}}`),
      approve("confirm", "Confirm the post", `Post this to [[channel]]?\n\n{{steps.check.output}}`),
      call("post", "Post the list", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.check.output}}" }),
    ),
  },
];
