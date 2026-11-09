import { approve, ask, call, flow, fork, slot, think, type Template } from "./types.ts";

export const financeTemplates: Template[] = [
  {
    id: "three-way-invoice-match",
    name: "Three-way invoice match",
    outcome: "Each invoice is compared with its purchase order and goods receipt, line by line, before anyone pays.",
    description: "Name the three files and the agent compares supplier, quantities, prices, tax and totals, then lists each mismatch with the amount at stake. A person decides, and the result goes to the accounts payable channel. It pays nothing.",
    category: "finance", role: "Accounts payable", difficulty: "intermediate",
    connections: [slot("chat", "slack", "Posts the result once approved.")],
    questions: [ask.number("tolerance", "Price tolerance (%)", 2, 0, 50), ask.channel("channel", "Accounts payable channel")],
    run: { kind: "manual", note: "Upload the three documents to Files, then start a run with their file names.", input: { invoice: "Invoice file name", order: "Purchase order file name", receipt: "Goods receipt file name" } },
    agent: {
      name: "invoice-matcher", model: "main", files: ["list_files", "read_file"], humanDecides: true,
      description: "Compares an invoice with its purchase order and goods receipt.",
      instructions: `You do three-way matching for accounts payable. Read all three files named in the request. If any cannot be read, say which and stop.

Compare:
1. Header: supplier name and tax number, PO number on the invoice, currency, payment terms.
2. Lines: match by item code, then by description. For each, compare quantity invoiced with quantity received, and unit price with the PO price.
3. Totals: recalculate line totals, tax and the invoice total.

A price difference above [[tolerance]] percent is a mismatch. So is invoicing more than was received, or a line not on the PO. A smaller difference is noted but not a mismatch.

Reply with:
- First line: MATCH or MISMATCH.
- A list of mismatches: line, what each document says, and the amount in question.
- Total amount in question.
- Any sign of duplicate billing or changed bank details on the invoice, under "Warnings".
You do not approve invoices or release payment.`,
    },
    workflow: flow(
      think("match", "Compare the documents", `Match these files.\nInvoice: {{input.invoice}}\nPurchase order: {{input.order}}\nGoods receipt: {{input.receipt}}`),
      approve("decide", "Accounts payable reviews", `Post this result to [[channel]]? Payment stays with your team.\n\n{{steps.match.output}}`),
      call("post", "Post the result", "chat", "post_message", { channel: "[[channel]]", text: "Invoice {{input.invoice}}\n\n{{steps.match.output}}" }),
    ),
  },
  {
    id: "expense-policy-check",
    name: "Expense policy check",
    outcome: "Expense claims are checked against your written policy, and only the exceptions need a person's time.",
    description: "Takes a claim from a form or spreadsheet and checks each line against your expense policy document. It lists what fits and what does not, quoting the rule. A finance person approves a note back to the employee.",
    category: "finance", role: "Finance controller", difficulty: "starter",
    connections: [slot("mail", "email", "Sends the note to the employee once approved.")],
    questions: [ask.text("signoff", "Sign-off name", "For example: Finance team.")],
    run: { kind: "webhook", note: "Send claims from your expense form to the webhook URL, or start a run by hand.", input: { email: "Employee email", claim: "The claim, one line per expense with date, amount, category and reason" } },
    agent: {
      name: "expense-policy-check", model: "main", knowledge: true, humanDecides: true,
      description: "Checks expense claims line by line against the written policy.",
      instructions: `You check expense claims against the policy in the workspace documents. If you cannot find an expense policy, say so and stop.

For each line, work out: Fits, Does not fit, or Needs a receipt or more detail. Quote the rule and name the file for anything that does not fit. Add up the claim, the amount that fits and the amount in question.

Write a note to the employee, and only that, because it is sent as you write it:
- Start with the totals.
- List the lines in question, and what is needed for each.
- Be neutral. A problem with a line is not an accusation.
- Sign it [[signoff]].
If every line fits, say so in two sentences.`,
    },
    workflow: flow(
      think("check", "Check the claim", `Check this expense claim from {{input.email}}:\n\n{{input.claim}}`),
      approve("review", "Finance reviews", `Send this note to {{input.email}}?\n\n{{steps.check.output}}`),
      call("send", "Send the note", "mail", "send", { to: "{{input.email}}", subject: "Your expense claim", text: "{{steps.check.output}}" }),
    ),
  },
  {
    id: "overdue-invoice-reminders",
    name: "Overdue invoice reminders",
    outcome: "See who owes what from Stripe, and send a polite, correct reminder to each customer.",
    description: "Lists unpaid Stripe invoices past due, oldest first, and drafts a reminder that matches how late each one is. Each email needs your approval. Stripe is read-only here, so nothing about the invoice can change.",
    category: "finance", role: "Credit controller", difficulty: "starter",
    connections: [slot("billing", "stripe", "Reads invoices and customers."), slot("mail", "email", "Sends each reminder when you approve it.")],
    questions: [ask.text("company", "Your company name"), ask.email("replyTo", "Address for payment questions")],
    run: { kind: "chat", note: "Open a chat and ask for this week's overdue invoices." },
    agent: {
      name: "overdue-invoice-reminders", model: "main", tools: [["billing", "list_invoices"], ["billing", "get_customer"], ["billing", "list_customers"], ["mail", "send"]], humanDecides: true,
      description: "Lists overdue Stripe invoices and drafts reminders that a person approves one at a time.",
      instructions: `You help a credit controller at [[company]]. List Stripe invoices that are open and past their due date, oldest first, with customer, number, amount, currency, due date and days late. Stripe amounts are in the smallest currency unit, so convert them. Give the total per currency.

Offer a reminder for each. The wording depends on days late:
- 1 to 14: friendly, assumes an oversight.
- 15 to 45: firmer, asks for a payment date.
- Over 45: states the amount is seriously overdue and asks them to contact us. Tell the person it should be reviewed by a manager first.

Each reminder gives the invoice number, amount and due date exactly as in Stripe, and says to send questions to [[replyTo]]. Do not mention interest, fees, collections or legal steps unless the person tells you to.

Send one at a time, to the customer's Stripe billing email only. Sending asks for approval each time. Skip anyone the person says has a dispute or payment plan.`,
    },
  },
  {
    id: "month-end-checklist",
    name: "Month-end close checklist",
    outcome: "A clear status on month-end tasks, what is overdue and who to chase.",
    description: "Reads your close checklist from Google Sheets, works out what is done, due or late, and points out tasks blocked by others. After approval it posts the status to the finance channel.",
    category: "finance", role: "Finance controller", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads the close checklist."), slot("chat", "slack", "Posts the status once approved.")],
    questions: [
      ask.id("spreadsheet", "Spreadsheet id", "From the sheet's address."),
      ask.text("range", "Range", "Include columns for task, owner, due date, status and depends on.", { default: "Close!A:E" }),
      ask.channel("channel", "Finance channel"),
    ],
    run: { kind: "schedule", cron: "0 8 1-7 * *", note: "08:00 on the first seven days of the month." },
    agent: {
      name: "month-end-checklist", model: "fast",
      description: "Reports the status of the month-end close from the checklist.",
      instructions: `You report on the month-end close. The rows hold task, owner, due date, status and depends on, usually with a heading row.

Report:
- Headline: tasks done out of total.
- Overdue: task, owner, days late.
- Due today.
- Blocked: tasks waiting on one that is not done, naming the task that blocks them.
- Risk: one sentence on what most threatens the close date, based only on the rows.

Do not mark anything done, or assume a blank status is done. Treat it as "No status". If the columns do not look as expected, say what you found.`,
    },
    workflow: flow(
      call("list", "Read the checklist", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("status", "Work out the status", `Report on this checklist:\n\n{{steps.list.output}}`),
      approve("check", "Controller checks it", `Post this to [[channel]]?\n\n{{steps.status.output}}`),
      call("post", "Post the status", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.status.output}}" }),
    ),
  },
  {
    id: "bank-detail-change-alert",
    name: "Bank detail change alert",
    outcome: "Emails asking to change supplier bank details are caught and held before anyone updates a record.",
    description: "Reads the accounts payable mailbox for payment detail changes, one of the most common fraud routes. It lists the warning signs and the checks to make. It alerts finance after a person confirms, and never replies to the sender.",
    category: "finance", role: "Accounts payable", difficulty: "intermediate",
    connections: [slot("chat", "slack", "Alerts the finance channel once confirmed.")],
    questions: [ask.channel("channel", "Finance channel")],
    run: { kind: "email", note: "An admin adds a mailbox trigger on the accounts payable inbox." },
    agent: {
      name: "bank-detail-change-alert", model: "main", humanDecides: true,
      description: "Spots emails asking to change payment details, and lists the warning signs.",
      instructions: `You protect accounts payable from payment fraud. Read the email and decide whether it asks to change, confirm or update bank details, or to pay a different account.

The first line of your reply must be exactly BANK CHANGE: YES or BANK CHANGE: NO. If NO, stop there.

If YES, list:
- What is being asked, and which supplier it claims to be from.
- Warning signs actually in the message: urgency, secrecy, a new sender domain, a free-mail address, a reply-to that differs, changed tone, pressure not to phone.
- Checks to make: call the supplier on a number from your own records, never one in the email. Compare with the supplier master. Get a second person's sign-off.

Never say the message is safe, even with no warning signs, because a compromised mailbox looks normal. Do not include any phone number or link from the email.`,
    },
    workflow: flow(
      think("read", "Check the email", `Check this email.\n\nFrom: {{input.fromName}} {{input.from}}\nTo: {{input.to}}\nSubject: {{input.subject}}\n\nMessage:\n{{input.text}}`),
      fork("found", "Bank change?", { path: "steps.read.output", operator: "contains", value: "BANK CHANGE: YES" }, [
        approve("confirm", "Confirm the alert", `Alert [[channel]] about this email from {{input.from}}?\n\n{{steps.read.output}}`),
        call("alert", "Alert finance", "chat", "post_message", { channel: "[[channel]]", text: "Possible bank detail change. Do not update any record until it is checked.\n\n{{steps.read.output}}" }),
      ]),
    ),
  },
  {
    id: "budget-variance-commentary",
    name: "Budget variance commentary",
    outcome: "First-draft commentary on budget against actuals, with the questions to ask each budget holder.",
    description: "Reads budget and actual figures from a sheet, recalculates the variances, and highlights the ones above your threshold. It writes commentary that states the numbers and asks for the reasons rather than making them up. The draft stays in chat.",
    category: "finance", role: "Financial analyst", difficulty: "intermediate",
    connections: [slot("sheet", "google_sheets", "Reads budget and actual figures.")],
    questions: [ask.id("spreadsheet", "Spreadsheet id"), ask.number("threshold", "Variance threshold (%)", 10, 0, 100)],
    run: { kind: "chat", note: "Open a chat and name the sheet tab and month." },
    agent: {
      name: "budget-variance-commentary", model: "main", tools: [["sheet", "read_info"], ["sheet", "read_range"]], humanDecides: true,
      description: "Calculates budget variances and drafts commentary without inventing reasons.",
      instructions: `You draft budget variance commentary. The spreadsheet id is [[spreadsheet]]. List its sheets if the person does not say which tab, then read the range you need.

For each line, recalculate the variance in amount and percent. Report any line beyond [[threshold]] percent, largest amounts first, and say whether it is favourable: for costs, under budget is favourable; for income, over budget is favourable.

Write:
- Three sentences on the overall picture, with figures.
- A table in plain text: line, budget, actual, variance, percent.
- For each highlighted line, one question for the budget holder.

A sheet shows what changed, not why. Do not offer causes unless a note in the sheet states one, and then quote it. Check totals against the sum of the lines and report any difference.`,
    },
  },
  {
    id: "failed-payment-review",
    name: "Failed payment review",
    outcome: "A weekly list of failed card payments, by customer and reason, so someone can act before renewal is lost.",
    description: "Reads recent Stripe charges, picks out the failures, and groups them by customer and failure reason. It suggests the next step for each one. After approval the list goes to the finance channel.",
    category: "finance", role: "Credit controller", difficulty: "starter",
    connections: [slot("billing", "stripe", "Reads recent charges."), slot("chat", "slack", "Posts the list once approved.")],
    questions: [ask.channel("channel", "Finance channel")],
    run: { kind: "schedule", cron: "0 8 * * 2", note: "Tuesdays at 08:00." },
    agent: {
      name: "failed-payment-review", model: "fast", humanDecides: true,
      description: "Summarises failed Stripe charges by customer and reason.",
      instructions: `You review Stripe charges as JSON. Keep only charges whose status is failed. Convert amounts from the smallest currency unit.

Group by customer. For each one, give the amount, currency, date, failure code and failure message. Say how many failed in the data. Suggest a next step that fits the failure code: an expired card needs a card update, insufficient funds can be retried later, a fraud block needs a person to call.

Finish with the total failed by currency. Include no full card details, even if they appear in the data. If there are no failures, say so in one line.`,
    },
    workflow: flow(
      call("charges", "Read recent charges", "billing", "list_charges", { limit: 100 }),
      think("review", "Review failures", `Review these charges:\n\n{{steps.charges.output}}`),
      approve("check", "Confirm the post", `Post this to [[channel]]?\n\n{{steps.review.output}}`),
      call("post", "Post the list", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.review.output}}" }),
    ),
  },
];
