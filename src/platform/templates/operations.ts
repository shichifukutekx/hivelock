import { approve, ask, call, flow, fork, slot, think, type Template } from "./types.ts";

export const operationsTemplates: Template[] = [
  {
    id: "supplier-certificate-expiry",
    name: "Supplier certificate expiry watch",
    outcome: "ISO, insurance and material certificates are chased before they lapse, not after an audit finds them.",
    description: "Reads your supplier certificate register from Google Sheets each week and lists what has expired or will expire soon. After approval the list goes to the purchasing channel. The agent also drafts the request you can send to each supplier.",
    category: "operations", role: "Purchasing manager", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads the certificate register."), slot("chat", "slack", "Posts the list once approved.")],
    questions: [
      ask.id("spreadsheet", "Register spreadsheet id"),
      ask.text("range", "Range", "Columns for supplier, certificate, number, expiry date, contact.", { default: "Certificates!A:E" }),
      ask.number("days", "Days of notice", 60, 7, 365),
      ask.channel("channel", "Purchasing channel"),
    ],
    run: { kind: "schedule", cron: "0 7 * * 1", note: "Mondays at 07:00." },
    agent: {
      name: "supplier-certificate-expiry", model: "fast",
      description: "Lists supplier certificates that have expired or are expiring soon.",
      instructions: `You watch supplier certificates. The rows hold supplier, certificate type, number, expiry date and contact. Sort them into:
- Expired: past today, oldest first, with days overdue.
- Expiring within [[days]] days: soonest first, with days left.
- Could not check: a date that is missing or unreadable.

Give the supplier, certificate, number and date for each. If a supplier has an expired certificate needed for approved-supplier status, as the sheet shows, say that purchasing should check before the next order.

Then write one short request a buyer can copy to a supplier, with a blank for the certificate name. If nothing is due, say so in one line.`,
    },
    workflow: flow(
      call("register", "Read the register", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("list", "Find what is due", `Check this certificate register:\n\n{{steps.register.output}}`),
      approve("check", "Purchasing checks it", `Post this to [[channel]]?\n\n{{steps.list.output}}`),
      call("post", "Post the list", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.list.output}}" }),
    ),
  },
  {
    id: "purchase-order-check",
    name: "Purchase order check",
    outcome: "Each draft PO is checked for approved supplier, price, terms and sign-off limit before it is issued.",
    description: "Name a draft purchase order in chat. The agent compares it with your approved supplier list, the supplier's quote and your purchasing rules, then lists what needs fixing. It changes nothing.",
    category: "operations", role: "Buyer", difficulty: "starter",
    connections: [], questions: [ask.number("limit", "Order value needing a second signature", 10000, 0, 100000000)],
    run: { kind: "chat", note: "Upload the draft PO and the quote to Files, and your approved supplier list and rules to the documents." },
    agent: {
      name: "purchase-order-check", model: "main", knowledge: true, files: ["list_files", "read_file"], humanDecides: true,
      description: "Checks a draft purchase order against the supplier list, the quote and purchasing rules.",
      instructions: `You check draft purchase orders before they are issued. Read the PO the person names, and the quote if they name one.

Check:
1. Supplier: is it on the approved supplier list in the documents? Quote the entry.
2. Items: description, part number, quantity, unit and unit price against the quote, line by line.
3. Arithmetic: line totals, tax and order total.
4. Terms: payment terms, delivery terms and delivery date against the quote and purchasing rules.
5. Sign-off: an order total above [[limit]] needs a second signature. Say whether the PO shows one.
6. Basics: PO number, date, delivery address, cost code.

Reply with Ready to issue or Needs changes, then a list of each problem with both values. If there is no quote to compare, say which checks you could not do.`,
    },
  },
  {
    id: "stock-alerts",
    name: "Low stock alerts",
    outcome: "A daily list of what is under its reorder point, with suggested quantities.",
    description: "Reads stock levels and reorder points from your stock sheet, works out what is short, and suggests how much to order using your own lead time and minimum order figures. After approval it goes to purchasing.",
    category: "operations", role: "Inventory planner", difficulty: "starter",
    connections: [slot("sheet", "google_sheets", "Reads stock levels."), slot("chat", "slack", "Posts the alert once approved.")],
    questions: [
      ask.id("spreadsheet", "Stock spreadsheet id"),
      ask.text("range", "Range", "Columns for part, description, on hand, on order, reorder point, reorder quantity, supplier.", { default: "Stock!A:G" }),
      ask.channel("channel", "Purchasing channel"),
    ],
    run: { kind: "schedule", cron: "0 6 * * 1-5", note: "Weekdays at 06:00." },
    agent: {
      name: "stock-alerts", model: "fast",
      description: "Lists parts under their reorder point and suggests quantities.",
      instructions: `You check stock. For each row, available stock is on hand plus on order. List parts where available stock is at or below the reorder point.

Group them by supplier. Give the part, description, on hand, on order, reorder point and the reorder quantity from the sheet. Put parts with zero on hand first, marked "Out of stock".

Use only the reorder quantity in the sheet. Do not work out a new one. Rows with missing or non-numeric values go under "Could not check". If nothing is short, say so in one line.`,
    },
    workflow: flow(
      call("stock", "Read stock levels", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("check", "Find shortages", `Check these stock levels:\n\n{{steps.stock.output}}`),
      approve("confirm", "Planner checks it", `Post this to [[channel]]?\n\n{{steps.check.output}}`),
      call("post", "Post the alert", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.check.output}}" }),
    ),
  },
  {
    id: "shopify-stock-watch",
    name: "Shop stock watch",
    outcome: "See which Shopify products are selling out, against what orders show this week.",
    description: "Reads products and recent orders from Shopify, and lists variants with low inventory, ordered by recent sales. The result goes to the operations channel after approval. Inventory is not changed.",
    category: "operations", role: "E-commerce manager", difficulty: "starter",
    connections: [slot("shop", "shopify", "Reads products and orders."), slot("chat", "slack", "Posts the list once approved.")],
    questions: [ask.number("threshold", "Low stock level", 10, 0, 100000), ask.channel("channel", "Operations channel")],
    run: { kind: "schedule", cron: "0 8 * * 1,4", note: "Mondays and Thursdays at 08:00." },
    agent: {
      name: "shop-stock-watch", model: "fast",
      description: "Lists Shopify variants running low, in order of recent sales.",
      instructions: `You watch shop stock. From the products, list variants with inventory at or below [[threshold]]. From the orders, count units sold of each one in the data you were given, and say how many days of orders that covers.

Order by units sold, highest first. Give the product, variant, SKU, stock and units sold. Where you can, give stock divided by daily sales as rough days of cover, labelled as an estimate. Variants that do not track inventory go in a one-line note.`,
    },
    workflow: flow(
      call("products", "Read products", "shop", "list_products", { limit: 100 }),
      call("orders", "Read recent orders", "shop", "list_orders", { limit: 100 }),
      think("check", "Find low stock", `Products:\n{{steps.products.output}}\n\nRecent orders:\n{{steps.orders.output}}`),
      approve("confirm", "Confirm the post", `Post this to [[channel]]?\n\n{{steps.check.output}}`),
      call("post", "Post the list", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.check.output}}" }),
    ),
  },
  {
    id: "supplier-quote-comparison",
    name: "Supplier quote comparison",
    outcome: "Several supplier quotes side by side, on the same units and terms, so the comparison is honest.",
    description: "Reads the quotes you name from Files and lines them up by item. It normalises units and currency only where the quote gives the facts, and lists differences in lead time, terms and exclusions. A buyer chooses.",
    category: "operations", role: "Buyer", difficulty: "starter",
    connections: [], questions: [],
    run: { kind: "chat", note: "Upload the quotes to Files, then name them in a chat." },
    agent: {
      name: "supplier-quote-comparison", model: "main", files: ["list_files", "read_file", "save_file"], humanDecides: true,
      description: "Compares supplier quotes line by line, including terms and exclusions.",
      instructions: `You compare supplier quotes. Read every file the person names. Say which files you read and the supplier and date of each.

Make a comparison with one row per item: description, quantity, and each supplier's unit price and total. If quantities or units differ, show a like-for-like price, with your working. Do not convert currency unless the person gives you a rate.

Then compare: lead time, delivery terms, payment terms, validity, warranty, minimum order, freight and tooling charges, and anything excluded.

Point out where the lowest price is not the lowest full cost, and where a quote leaves out something others include. Items quoted by only one supplier are flagged. Do not choose a supplier: list the trade-offs for the buyer. If the person asks, save the comparison as a .csv. Saving asks for approval.`,
    },
  },
  {
    id: "supplier-delay-triage",
    name: "Supplier delay triage",
    outcome: "Delay emails from suppliers become a clear note: which order, how late, and what it affects.",
    description: "Reads supplier emails in your purchasing mailbox and picks out the order number, the old and new dates and the reason. It checks your open orders sheet for what is affected. After approval it alerts the planning channel.",
    category: "operations", role: "Buyer", difficulty: "intermediate",
    connections: [slot("sheet", "google_sheets", "Reads open purchase orders."), slot("chat", "slack", "Alerts planning once approved.")],
    questions: [ask.id("spreadsheet", "Open orders spreadsheet id"), ask.text("range", "Range", "Columns for PO, supplier, item, due date, needed for.", { default: "OpenPOs!A:E" }), ask.channel("channel", "Planning channel")],
    run: { kind: "email", note: "An admin adds a mailbox trigger on the purchasing inbox." },
    agent: {
      name: "supplier-delay-triage", model: "main",
      description: "Extracts delivery delays from supplier emails and shows what they affect.",
      instructions: `You read supplier emails about deliveries. You are given the email and the open orders.

If the email is not about a delay or a date change, the first line of your reply is NO DELAY and you stop there.

Otherwise give:
- Supplier and PO number, as stated. Check the PO is in the open orders. If it is not, say so.
- Items affected.
- Original date and new date, and the days of delay.
- Reason, as the supplier states it. If there is none, write "Not stated".
- What it affects, from the "needed for" column.
- Suggested action for the buyer: one concrete step.

A date that is only "soon" or "next week" is not a date. Report those words as they are.`,
    },
    workflow: flow(
      call("orders", "Read open orders", "sheet", "read_range", { spreadsheetId: "[[spreadsheet]]", range: "[[range]]" }),
      think("read", "Read the email", `From: {{input.from}}\nSubject: {{input.subject}}\n\nMessage:\n{{input.text}}\n\nOpen orders:\n{{steps.orders.output}}`),
      fork("skip", "Not a delay?", { path: "steps.read.output", operator: "contains", value: "NO DELAY" }, [], [
        approve("confirm", "Buyer checks it", `Post this to [[channel]]?\n\n{{steps.read.output}}`),
        call("post", "Alert planning", "chat", "post_message", { channel: "[[channel]]", text: "{{steps.read.output}}" }),
      ]),
    ),
  },
  {
    id: "shift-handover",
    name: "Shift handover note",
    outcome: "Rough end-of-shift notes become a clear handover the next shift can act on.",
    description: "Paste or send the outgoing shift's notes. The agent sorts them into safety, quality, breakdowns, output and open actions. After a supervisor approves, it posts to the plant channel.",
    category: "operations", role: "Production supervisor", difficulty: "starter",
    connections: [slot("chat", "teams", "Posts the handover once approved.")],
    questions: [],
    run: { kind: "manual", note: "Start a run at the end of each shift.", input: { shift: "Shift and date", notes: "The outgoing shift's notes" } },
    agent: {
      name: "shift-handover", model: "fast",
      description: "Turns rough shift notes into a clear handover.",
      instructions: `You turn rough shift notes into a handover. Keep every fact and add none.

Use these headings, in this order, and leave out any with nothing under it:
- Safety: incidents, near misses, hazards.
- Quality: holds, rejects, deviations.
- Equipment: breakdowns, what is running or down, who is on it.
- Output: figures, as given.
- For the next shift: actions, each with who and by when if the notes say.

Safety items always come first and are never softened. If notes are unclear, for example no machine named, add it under "Unclear, ask before leaving". Plain short lines, no introduction.`,
    },
    workflow: flow(
      think("note", "Write the handover", `Shift: {{input.shift}}\n\nNotes:\n{{input.notes}}`),
      approve("review", "Supervisor reviews", `Post this handover?\n\n{{steps.note.output}}`),
      call("post", "Post the handover", "chat", "post_message", { text: "Handover: {{input.shift}}\n\n{{steps.note.output}}" }),
    ),
  },
];
