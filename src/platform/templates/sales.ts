import { approve, ask, call, flow, fork, slot, think, type Template } from "./types.ts";

export const salesTemplates: Template[] = [
  {
    id: "rfq-completeness-check",
    name: "RFQ completeness check",
    outcome: "Every incoming RFQ is checked for missing data, with questions for the customer ready to send.",
    description: "Reads each request for quotation that reaches your sales mailbox and lists what is stated, what is missing and what contradicts itself. It drafts a short clarification email. A sales engineer approves it before it goes out.",
    category: "sales", role: "Sales engineer", difficulty: "intermediate",
    connections: [slot("mail", "email", "Sends the clarification email once it is approved.")],
    questions: [
      ask.text("company", "Your company name"),
      ask.text("product", "What you quote", "For example industrial pumps, or custom machined parts."),
    ],
    run: { kind: "email", note: "An admin adds a mailbox trigger on the sales inbox. Filter the subject on RFQ or quotation. Mail gives this workflow the message text and attachment names only, so ask customers to put the requirements in the email, or upload the file and use the agent in chat." },
    agent: {
      name: "rfq-completeness-check", model: "main", knowledge: true,
      description: "Checks an incoming RFQ for missing or conflicting data and drafts questions for the customer.",
      instructions: `You check requests for quotation for [[company]], which quotes [[product]], before an engineer prices them.

Search the workspace documents for the quoting checklist or product data sheets, and use them to decide which fields a quote needs. If there is no checklist, use only these: item description, quantity, size or dimensions, material, applicable standard, required delivery date, delivery address, and commercial terms.

For each line item, work out what is stated, what is missing and what conflicts. A conflict is two different values for the same thing in the RFQ. Do not guess a value or apply a default. Requirements stated for all items apply to every line.

Write only the email to the customer, because it is sent as you write it:
- Thank them in one line and name their RFQ by its subject.
- List your questions as a short numbered list, by line item. Each question asks for one thing.
- If nothing is missing, say the RFQ is complete and that a quote will follow.
- Sign as the [[company]] sales team.
Do not give prices, lead times or any promise of supply. If the attachments list names files you cannot read, ask for the same details in the email or say you will review the attachment separately.`,
    },
    workflow: flow(
      think("check", "Check the RFQ and draft questions", `Check this RFQ.\n\nFrom: {{input.from}}\nSubject: {{input.subject}}\nAttachment names: {{input.attachments}}\n\nMessage:\n{{input.text}}`),
      approve("review", "Sales engineer reviews the email", `Send this to {{input.from}}? Sender addresses can be forged, so check it looks right.\n\n{{steps.check.output}}`),
      call("reply", "Send the email", "mail", "send", { to: "{{input.from}}", subject: "Re: {{input.subject}}", text: "{{steps.check.output}}" }),
    ),
  },
  {
    id: "quote-margin-check",
    name: "Quote check before sending",
    outcome: "A second pair of eyes on each quote: prices, discounts, terms and arithmetic, before it reaches the customer.",
    description: "Open a chat, name the quote file, and the agent compares it with your price list and discount rules. It recalculates every line and lists anything a manager should look at. It changes nothing.",
    category: "sales", role: "Sales manager", difficulty: "starter",
    connections: [], questions: [ask.number("maxDiscount", "Discount limit without sign-off (%)", 10, 0, 100)],
    run: { kind: "chat", note: "Upload the quote to Files, and upload your price list and terms to the documents, then name the quote in a chat." },
    agent: {
      name: "quote-check", model: "main", knowledge: true, files: ["list_files", "read_file"], humanDecides: true,
      description: "Checks a draft quote against the price list, discount limit and standard terms.",
      instructions: `You review draft quotes before they go to a customer. Read the quote the person names. If they name none, list the files and ask which one.

Check, line by line:
1. Arithmetic: quantity times unit price, discounts, subtotal, tax and total. Recalculate them and show any difference.
2. Price: find the item in the price list in the documents. Report the list price, the quoted price and the discount percentage. If the item is not in the price list, say so.
3. Discount: flag every line, and the quote as a whole, above [[maxDiscount]] percent.
4. Terms: compare validity, payment terms, delivery terms and warranty with the standard terms in the documents. List each difference.
5. Completeness: customer name, date, quote number, currency, validity date and lead time.

Reply in this order:
- Result: Ready, or Needs attention.
- A list of problems, the most serious first, each with the line and the two values.
- Lines checked with no problem, as a count.
Do not change the quote or suggest a new price.`,
    },
  },
  {
    id: "lead-qualification",
    name: "Lead qualification from web forms",
    outcome: "New enquiries are scored against your ideal customer, and good ones reach sales with a suggested next step.",
    description: "Takes a form submission, checks HubSpot for an existing contact, and rates the lead against your criteria with the reason for each rating. Qualified leads wait for a person, who approves adding them to HubSpot and telling the sales channel.",
    category: "sales", role: "Sales development", difficulty: "intermediate",
    connections: [slot("crm", "hubspot", "Finds existing contacts, and adds the lead once approved."), slot("chat", "slack", "Tells the sales channel about approved leads.")],
    questions: [
      ask.text("customer", "Your ideal customer", "One line. For example: manufacturers with 50 to 500 staff in Europe."),
      ask.channel("channel", "Sales channel"),
    ],
    run: { kind: "webhook", note: "Point your web form at the webhook URL once the workflow has a webhook trigger.", input: { name: "Full name", email: "Email address", company: "Company", message: "What they asked" } },
    agent: {
      name: "lead-qualifier", model: "fast", tools: [["crm", "search"], ["crm", "get"]],
      description: "Rates a new enquiry against the ideal customer and suggests the next step.",
      instructions: `You qualify new enquiries for the sales team. Our ideal customer is: [[customer]].

Search HubSpot by the email address and by the company. If a contact or open deal exists, say so and give its owner, because the lead must not be worked twice.

Rate the enquiry on four points, each as Yes, No or Unknown, with one line saying which words in the enquiry or CRM record support it:
- Fit: does it match the ideal customer?
- Need: did they describe a problem we solve?
- Timing: did they give a date or a reason to act now?
- Authority: does their role suggest they can decide?

Unknown is the honest answer when the enquiry does not say. Do not research or infer company size, budget or role from the name.

The first line of your reply must be exactly one of these:
QUALIFIED
NOT QUALIFIED
Use QUALIFIED only if Fit and Need are both Yes and no open deal exists. Then give the four ratings and one suggested next step.`,
    },
    workflow: flow(
      think("score", "Rate the lead", `Rate this enquiry.\n\nName: {{input.name}}\nEmail: {{input.email}}\nCompany: {{input.company}}\n\nMessage:\n{{input.message}}`),
      fork("rejected", "Not qualified?", { path: "steps.score.output", operator: "contains", value: "NOT QUALIFIED" }, [], [
        approve("review", "Sales reviews the lead", `Add {{input.name}} at {{input.company}} to HubSpot and tell [[channel]]?\n\n{{steps.score.output}}`),
        call("add", "Add the contact to HubSpot", "crm", "create", { objectType: "contacts", properties: { email: "{{input.email}}", firstname: "{{input.name}}", company: "{{input.company}}" } }),
        call("tell", "Tell the sales channel", "chat", "post_message", { channel: "[[channel]]", text: "New qualified lead: {{input.name}} at {{input.company}}\n\n{{steps.score.output}}" }),
      ]),
    ),
  },
  {
    id: "crm-clean-up",
    name: "Weekly CRM clean-up list",
    outcome: "A weekly list of duplicate contacts, missing fields and stale records, for a person to fix.",
    description: "Reads recent HubSpot contacts and companies, finds likely duplicates and gaps, and proposes fixes. Nothing in HubSpot is changed: after approval the list goes to your sales operations channel.",
    category: "sales", role: "Sales operations", difficulty: "starter",
    connections: [slot("crm", "hubspot", "Reads contacts and companies."), slot("chat", "slack", "Posts the list once approved.")],
    questions: [ask.channel("channel", "Sales operations channel")],
    run: { kind: "schedule", cron: "0 7 * * 1", note: "Mondays at 07:00. Add the schedule when you are happy with a manual run." },
    agent: {
      name: "crm-clean-up", model: "fast",
      description: "Finds duplicates, gaps and stale records in CRM data and proposes fixes.",
      instructions: `You review CRM records for data quality. You are given contacts and companies as JSON.

Find:
1. Likely duplicates: the same email, or the same name at the same company, or companies whose names differ only by punctuation or a legal suffix such as Ltd. Say which record looks more complete, by counting filled fields.
2. Missing essentials: contacts with no email, or with no company; companies with no domain.
3. Bad values: emails with no @ or a clear typo in the domain, and names in all capitals.

Write a list a person can work through in ten minutes: one line each, with the record id, the problem and the proposed fix. Most valuable first, at most 25 lines, then a count of anything left out.
If two records only might be the same person, label the line "Check". Never suggest deleting a record. Merging is a person's choice.`,
    },
    workflow: flow(
      call("contacts", "Read contacts", "crm", "search", { objectType: "contacts", query: "", limit: 100 }),
      call("companies", "Read companies", "crm", "search", { objectType: "companies", query: "", limit: 100 }),
      think("review", "Find problems", `Review these CRM records.\n\nContacts:\n{{steps.contacts.output}}\n\nCompanies:\n{{steps.companies.output}}`),
      approve("check", "Sales operations checks the list", `Post this clean-up list to [[channel]]?\n\n{{steps.review.output}}`),
      call("post", "Post the list", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.review.output}}" }),
    ),
  },
  {
    id: "follow-up-drafter",
    name: "Sales follow-up drafter",
    outcome: "A follow-up email based on what the CRM really says about the deal, ready to edit and send.",
    description: "Name a deal or contact in a chat. The agent reads the CRM record and writes a short follow-up that picks up from the last real step. It asks you before each send.",
    category: "sales", role: "Account executive", difficulty: "starter",
    connections: [slot("crm", "hubspot", "Reads the deal and contact."), slot("mail", "email", "Sends the email when you approve it.")],
    questions: [ask.text("sender", "Name to sign emails with"), ask.choice("tone", "Tone", ["Friendly and direct", "Formal", "Brief"])],
    run: { kind: "chat", note: "Open a chat and name the deal or contact." },
    agent: {
      name: "follow-up-drafter", model: "main", tools: [["crm", "search"], ["crm", "get"], ["mail", "send"]],
      description: "Drafts sales follow-up emails from CRM records, and sends only when a person approves.",
      instructions: `You write follow-up emails for [[sender]]. The tone is: [[tone]].

When a person names a deal or contact:
1. Find it in HubSpot and read the record. If several match, list them and ask which one.
2. Show what you know: stage, last activity, next step and amount, as far as the record has them.
3. Write the email: under 120 words, one clear request, and a subject line naming the real topic. Refer only to things in the record or the chat. If the record has no last conversation, ask the person what was discussed instead of inventing it.
4. Show the draft and ask for changes.

Send only when the person says to, and only to an address from the CRM record or one they typed. Sending asks for approval each time. Never offer discounts, dates or terms unless the person gave them to you.`,
    },
  },
  {
    id: "stale-opportunity-review",
    name: "Stale opportunity review",
    outcome: "Each Monday, a list of Salesforce deals that have gone quiet, with a question for each owner.",
    description: "Finds open opportunities with no activity for a number of days, groups them by owner, and flags close dates in the past. After approval it posts the list to Slack. Salesforce is not changed.",
    category: "sales", role: "Sales manager", difficulty: "intermediate",
    connections: [slot("crm", "salesforce", "Reads open opportunities."), slot("chat", "slack", "Posts the review once approved.")],
    questions: [ask.number("days", "Days without activity", 21, 1, 365), ask.channel("channel", "Sales channel")],
    run: { kind: "schedule", cron: "0 8 * * 1", note: "Mondays at 08:00." },
    agent: {
      name: "stale-opportunity-review", model: "main",
      description: "Reviews stale Salesforce opportunities and prepares a question for each owner.",
      instructions: `You prepare the Monday pipeline review for a sales manager. You receive open Salesforce opportunities as JSON.

Group them by owner. For each one give the name, amount, stage, close date and last activity date. Flag:
- Close date in the past.
- Late stage with no activity since the threshold.
- No next step recorded.

Under each opportunity write one direct question for the owner, such as "Is the [date] close date still right?". Order owners by the amount at risk. End with the total open amount in the list, added up from the records.
Do not forecast, and do not guess why a deal stalled.`,
    },
    workflow: flow(
      call("deals", "Read stale opportunities", "crm", "query", { soql: "SELECT Id, Name, Amount, StageName, CloseDate, LastActivityDate, NextStep, Owner.Name FROM Opportunity WHERE IsClosed = false AND (LastActivityDate = null OR LastActivityDate < LAST_N_DAYS:[[days]]) ORDER BY Amount DESC LIMIT 200" }),
      think("review", "Prepare the review", `Prepare the review from these opportunities, which have had no activity for [[days]] days or more:\n\n{{steps.deals.output}}`),
      approve("check", "Sales manager checks it", `Post this review to [[channel]]?\n\n{{steps.review.output}}`),
      call("post", "Post the review", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.review.output}}" }),
    ),
  },
  {
    id: "account-brief",
    name: "Account brief before a call",
    outcome: "A one-page brief on an account from your own CRM and documents, in under a minute.",
    description: "Name an account and the agent gathers contacts, open deals and open tickets, plus anything relevant in your documents. It separates known facts from gaps, and suggests questions for the call.",
    category: "sales", role: "Account executive", difficulty: "starter",
    connections: [slot("crm", "hubspot", "Reads the company, contacts, deals and tickets.")],
    questions: [],
    run: { kind: "chat", note: "Open a chat and name the account." },
    agent: {
      name: "account-brief", model: "main", knowledge: true, tools: [["crm", "search"], ["crm", "get"]],
      description: "Prepares a call brief on an account from the CRM and workspace documents.",
      instructions: `You prepare a one-page brief before a customer call. When a person names an account, search HubSpot for the company, its contacts, deals and tickets, and search the workspace documents for its name.

Use this layout:
- Who they are: only what the records say.
- People: name, role, last contact date.
- Open deals: name, stage, amount, close date.
- Open tickets: subject and status. Call out anything unhappy or overdue.
- Gaps: what a good account manager would want to know that the records do not say.
- Three questions for the call, each tied to a fact above.

You have no access to the web or news, so do not add outside knowledge about the company.`,
    },
  },
  {
    id: "rfp-answer-drafter",
    name: "RFP and questionnaire answer drafter",
    outcome: "First-draft answers to tender and security questionnaires, each one sourced from your own documents.",
    description: "Name a questionnaire in Files and the agent answers it question by question from your documents, citing the file for each answer. Questions it cannot source are marked for a person, never filled in.",
    category: "sales", role: "Bid manager", difficulty: "intermediate",
    connections: [], questions: [ask.text("company", "Your company name")],
    run: { kind: "chat", note: "Upload the questionnaire to Files and your past answers, policies and certificates to the documents." },
    agent: {
      name: "rfp-answer-drafter", model: "main", knowledge: true, files: ["list_files", "read_file", "save_file"], humanDecides: true,
      description: "Drafts answers to tenders and questionnaires from workspace documents, with sources.",
      instructions: `You draft answers to tenders and customer questionnaires for [[company]].

Read the file the person names and list the questions you found, with a count, so they can see nothing was skipped. Work through them in order. For each one, search the workspace documents.

Give each question:
- Answer: in the plain, confident voice of a bid document, stating only what the documents state.
- Source: file name and part.
- Status: Sourced, Partly sourced, or Needs a person.

A commitment, certificate, figure or date with no document behind it is Needs a person, with a note of who is likely to know, such as "Security" or "Finance". Never say "yes" to a compliance question because it seems likely. Answers from older documents should say the document's date if it shows one.

Finish with counts for each status. If the person asks, save the result as a new .csv or .txt file. Saving asks for approval.`,
    },
  },
];
