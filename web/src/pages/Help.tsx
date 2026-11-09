import { Activity, ArrowRight, BookMarked, Bot, Cable, ClipboardCheck, FolderOpen, HelpCircle, KeyRound, LayoutTemplate, LifeBuoy, Map, MessageSquare, Search, ShieldCheck, Users, Workflow, type LucideIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Card, Input, PageHeader } from "../components/ui.tsx";
import { useWorkspace } from "../lib/workspace.ts";

interface Topic { id: string; title: string; icon: LucideIcon; words: string; body: (to: (path: string) => string) => ReactNode }

const P = ({ children }: { children: ReactNode }) => <p className="mb-3 leading-relaxed">{children}</p>;
const H = ({ children }: { children: ReactNode }) => <h3 className="mt-5 mb-2 text-[14px] font-semibold">{children}</h3>;
const L = ({ items }: { items: ReactNode[] }) => <ul className="mb-3 list-disc space-y-1.5 pl-5 leading-relaxed">{items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
const O = ({ items }: { items: ReactNode[] }) => <ol className="mb-3 list-decimal space-y-1.5 pl-5 leading-relaxed">{items.map((item, index) => <li key={index}>{item}</li>)}</ol>;
const Go = ({ to, children }: { to: string; children: ReactNode }) => <Link to={to} className="font-medium text-accent hover:underline">{children}</Link>;
const Term = ({ name, children }: { name: string; children: ReactNode }) => (
  <div className="grid gap-1 border-b border-line py-2.5 last:border-0 sm:grid-cols-[9rem_1fr] sm:gap-4"><dt className="font-medium">{name}</dt><dd className="text-muted">{children}</dd></div>
);

/** The flow of the whole app in one row: where work comes from, what does it, and where it ends up. */
function Flow() {
  const parts: [LucideIcon, string, string][] = [
    [Cable, "Connections", "Your systems, such as Sage or email"],
    [Bot, "Agents", "Read, think and write"],
    [Workflow, "Workflows", "Steps in order, on a timer or by hand"],
    [ClipboardCheck, "Approvals", "A person says yes before anything goes out"],
    [Activity, "Runs", "Every result, kept"],
  ];
  return (
    <div className="my-4 grid gap-2 sm:grid-cols-5">
      {parts.map(([Icon, name, note], index) => (
        <div key={name} className="relative rounded-xl border border-line bg-raised p-3">
          <Icon size={16} className="text-accent" />
          <p className="mt-1.5 text-[13px] font-medium">{name}</p>
          <p className="text-[12px] leading-snug text-muted">{note}</p>
          {index < parts.length - 1 && <ArrowRight size={14} className="absolute top-1/2 -right-2.5 z-10 hidden -translate-y-1/2 rounded-full bg-surface text-faint sm:block" />}
        </div>
      ))}
    </div>
  );
}

const TOPICS: Topic[] = [
  {
    id: "overview", title: "How it fits together", icon: Map,
    words: "overview flow start what is agents workflows runs approvals connections",
    body: () => (
      <>
        <P>This app gives your team AI assistants that work with your own systems. They read data, write summaries and drafts, and do routine checks. They never act on the outside world without a person agreeing first.</P>
        <Flow />
        <P>There are two ways to use it. Most people do both.</P>
        <L items={[
          <><b>Ask an agent.</b> Open an agent and type a question, the way you would ask a colleague. You get an answer in a few seconds, with tables where there is data.</>,
          <><b>Let a workflow do it.</b> A workflow does the same job every time: every Monday morning, or each time someone presses Run. It reads the data, an agent writes the result, and a person approves it before it is emailed.</>,
        ]} />
        <P>Everything that happens is recorded. You can always see what an agent read, what it wrote, who approved it and what it cost.</P>
      </>
    ),
  },
  {
    id: "first-day", title: "Your first day", icon: LifeBuoy,
    words: "start begin first day setup getting started template",
    body: (to) => (
      <>
        <P>If someone has already set the workspace up for you, skip to step 3.</P>
        <O items={[
          <><b>Add an AI model.</b> In <Go to={to("/settings#models")}>Settings</Go>, under AI models, add the key from your AI provider. An admin usually does this once for everyone.</>,
          <><b>Connect a system.</b> In <Go to={to("/connections")}>Connections</Go>, add the database, mailbox or app the agents should work with. Use a read-only login wherever you can.</>,
          <><b>Pick something ready-made.</b> <Go to={to("/templates")}>Templates</Go> has agents and workflows for common jobs. Installing one takes a minute, and nothing runs until you turn it on.</>,
          <><b>Ask it something.</b> Open the agent from <Go to={to("/agents")}>Agents</Go> and click one of the example questions, or type your own.</>,
          <><b>Run a workflow once by hand</b> from <Go to={to("/workflows")}>Workflows</Go>, check the result, then turn it on so it runs on its own.</>,
        ]} />
      </>
    ),
  },
  {
    id: "agents", title: "Chatting with agents", icon: MessageSquare,
    words: "agent chat ask question example attach file memory new chat edit title",
    body: (to) => (
      <>
        <P>An agent is an assistant with one job, such as answering order questions from Sage or checking a certificate. Each agent can only reach what it was given: certain connections, the documents in Files, or nothing outside the chat.</P>
        <H>Asking well</H>
        <L items={[
          "Say what you want in plain words. \"Late purchase orders for supplier S-1042, worst first\" works better than \"PO report\".",
          "Use part of a name if you are not sure of it. If several customers or suppliers match, the agent lists them and asks which one.",
          "Follow up naturally: \"same for last month\", \"only the second one\", \"as a table\". The agent remembers the whole chat.",
          "Attach a file with the paperclip if the agent should read something you have not uploaded yet.",
        ]} />
        <H>When an agent wants to do something</H>
        <P>Reading is free. Anything that changes something, such as sending an email or saving a file, stops and asks you first, inside the chat. Nothing happens until you press Approve.</P>
        <H>Past chats</H>
        <P>Every chat is kept on the left of the agent's page. Start a fresh one with New chat when you change subject, because a long chat about something else can confuse the answer.</P>
        <H>Changing an agent</H>
        <P>Builders and admins can press Edit to change the agent's title, what it does, its instructions, its example questions, and what it can use. In <Go to={to("/agents")}>Agents</Go>, the ones under "Used in workflows" each do one step of a workflow. You can chat with them to try them out.</P>
      </>
    ),
  },
  {
    id: "workflows", title: "Workflows and schedules", icon: Workflow,
    words: "workflow schedule trigger webhook email live draft run steps condition approval version",
    body: (to) => (
      <>
        <P>A workflow is a fixed series of steps. Use one when the same job comes round again and again: a morning report, a check on every new order, a reply to a type of email.</P>
        <H>Making one from a description</H>
        <P>Press New workflow and say what you want in your own words, for example "every weekday at 8:00, list the late sales orders by customer and email them to me after I check". You get a draft to review: its steps, the agent that does the work, and the schedule. Nothing is created until you press Create workflow.</P>
        <P>You never need to write a database query. Reading data is done by an agent step: you say what data you need in plain words, and the agent writes the query each time it runs. If one of your agents already fits the job, the draft uses it, and you can open that agent from the review.</P>
        <H>The kinds of step</H>
        <dl className="mb-3">
          <Term name="Agent">An agent reads what came before and writes something: a summary, a list, a draft.</Term>
          <Term name="Connection">Reads from or writes to one of your systems, such as a Sage query or sending an email.</Term>
          <Term name="Approval">The workflow stops and waits for a person. Nothing after it happens until someone approves.</Term>
          <Term name="Condition">Takes one path or another depending on a value, for example only email if something is late.</Term>
        </dl>
        <H>Starting a workflow</H>
        <L items={[
          <><b>By hand.</b> Press Run in <Go to={to("/workflows")}>Workflows</Go>. If it needs details, such as an order number, a form asks for them.</>,
          <><b>On a schedule.</b> Open the workflow and add a schedule under Triggers, such as weekdays at 07:30.</>,
          <><b>From another system.</b> A webhook gives the workflow a private address another system can call.</>,
          <><b>When mail arrives</b>, on editions that include mailbox triggers.</>,
        ]} />
        <H>Filtering what starts a run</H>
        <P>A webhook can send far more than you need: every order, when you only care about the paid ones over 500. Under Triggers, press <b>Add a filter</b> on the webhook and set the conditions, such as <i>order.status is paid</i> and <i>order.total is more than 500</i>. Deliveries that do not match start nothing and cost nothing; the trigger shows how many were skipped.</P>
        <H>Live and Draft</H>
        <P>A Draft workflow only runs when someone presses Run. Turn it Live and its schedules and other triggers start working. Turn it off at any time. Runs already started finish.</P>
        <H>Changing a workflow</H>
        <P>Open it to see the steps as a diagram. Click a step to change it, then save. Every save is kept as a version, so you can go back.</P>
      </>
    ),
  },
  {
    id: "results", title: "Runs and results", icon: Activity,
    words: "run result where see output succeeded failed waiting retry timeline report",
    body: (to) => (
      <>
        <P>Each time a workflow runs, the run is kept, with its result. There are three ways to reach it:</P>
        <L items={[
          <>In <Go to={to("/workflows")}>Workflows</Go>, click <b>See result</b> next to the last run.</>,
          <>In <Go to={to("/runs")}>Runs</Go>, every run of every workflow, newest first. Search or filter by status.</>,
          <>On the <Go to={to("")}>Overview</Go>, under Recent runs.</>,
        ]} />
        <P>A run opens on its <b>Result</b>: the report or draft the agent wrote, ready to read or copy. The <b>Steps</b> tab shows the workflow as a diagram. Click any step to see exactly what it read and wrote.</P>
        <H>What the statuses mean</H>
        <dl className="mb-3">
          <Term name="Running">Working on it now.</Term>
          <Term name="Waiting">Stopped at an approval. Someone needs to approve or decline it.</Term>
          <Term name="Succeeded">Finished. The result is ready.</Term>
          <Term name="Failed">A step could not finish. The run shows which step and why, in plain words. Fix the cause, then press Run again.</Term>
          <Term name="Cancelled">Someone stopped it.</Term>
        </dl>
        <H>Excel and PDF</H>
        <P>Any result, and any agent answer with a table, has a Download menu: an Excel spreadsheet with one sheet per table and real numbers you can add up, a PDF ready to print or send, or a CSV. Save to Files keeps a copy in the Reports folder for others. You can also ask an agent to "save this as Excel" or "as a PDF", and a workflow's email step can attach the report as Excel or PDF.</P>
        <P>The Timeline button shows each AI call and tool use in order, how long it took and what it cost. It is useful when something was slow or surprising.</P>
      </>
    ),
  },
  {
    id: "approvals", title: "Approvals", icon: ClipboardCheck,
    words: "approval approve decline waiting check email send who can",
    body: (to) => (
      <>
        <P>An approval is the point where a person looks before anything leaves the building. Workflows wait at their approval step, and agents ask inside the chat before they change anything.</P>
        <L items={[
          <><Go to={to("/approvals")}>Approvals</Go> lists everything waiting, with a count in the menu.</>,
          "Read what will be sent, then Approve or Decline. Declining ends that run and nothing is sent.",
          "Operators, builders, admins and owners can approve. Viewers can look, but cannot approve.",
        ]} />
        <P>If something is wrong with a draft, decline it, then fix the workflow or chat with the agent to get a better version.</P>
      </>
    ),
  },
  {
    id: "connections", title: "Connections", icon: Cable,
    words: "connection database email sage api key password tls edit secret read only",
    body: (to) => (
      <>
        <P>A connection lets agents and workflows reach one of your systems: a database, a mailbox, a web service and so on. Admins add them in <Go to={to("/connections")}>Connections</Go>.</P>
        <L items={[
          "Passwords and keys are stored encrypted. Once saved, nobody can read them back, including admins. Agents never see them.",
          "Give each connection the least it needs. For a database, a read-only login is enough for reports and questions.",
          "Use Test to check a connection works. If it fails, the message says what to change.",
          "Edit a connection to change its settings. If you change where it points, you must type the password again, so a saved password cannot be sent somewhere new.",
        ]} />
        <H>Rules for each action</H>
        <P>Press <b>Rules</b> on a connection to see what agents may do with it. By default they read freely and ask a person before changing anything. An admin can make any action stricter: <b>Ask every time</b>, even just to read, or <b>Off</b>, so no agent or workflow can use it. No rule can make an action skip the person who approves changes.</P>
      </>
    ),
  },
  {
    id: "memory", title: "Company memory", icon: BookMarked,
    words: "memory company notes rules policy facts remember suggest learn every agent",
    body: (to) => (
      <>
        <P><Go to={to("/memory")}>Company memory</Go> holds short notes that every agent in this workspace follows: "Quote prices in euros, without VAT", "Our financial year runs April to March", "Orders over 5,000 EUR need the director's sign-off". Write a fact down once, and nobody has to repeat it in each chat.</P>
        <L items={[
          "Builders, admins and owners add, change and remove notes. Everyone can read them.",
          "Agents with memory turned on can suggest a note while they work, when they learn something that holds for the whole company. A suggestion does nothing until someone accepts it, and you can change the wording first.",
          "Keep each note to one fact or rule. A person's own request in a chat still comes first.",
          "Notes are stored encrypted and stay inside this workspace.",
        ]} />
        <P>An agent's own memory, under each agent, is different: it is for that agent alone.</P>
      </>
    ),
  },
  {
    id: "files", title: "Files and documents", icon: FolderOpen,
    words: "file upload document search pdf excel csv view download procedure",
    body: (to) => (
      <>
        <P><Go to={to("/files")}>Files</Go> holds the documents your agents may read: procedures, price lists, certificates, reports. PDF, Excel, CSV and text files up to 15 MB each, kept in folders the way you organise them.</P>
        <L items={[
          "Upload several files at once, or a whole folder with everything inside it. You can also drag files and folders straight onto the page.",
          "Make folders inside folders with New folder. Click a folder to open it, and use the path at the top to go back up.",
          "Tick several items to download them as one zip, move or copy them to another folder, or delete them together. The ⋯ menu on each row does the same for one item, plus rename.",
          "Nothing is ever overwritten. A file with a name already in use is saved as \"name (2)\".",
          "Click a file to view it. CSV and Excel files open as tables. Uploaded files become searchable in a minute, and the search box looks inside every document.",
          "Files in one workspace are never visible from another.",
        ]} />
      </>
    ),
  },
  {
    id: "templates", title: "Templates", icon: LayoutTemplate,
    words: "template install customise copy starter pack ready made",
    body: (to) => (
      <>
        <P><Go to={to("/templates")}>Templates</Go> are ready-made agents and workflows. Each one says what you get, which connections it needs, and where a person approves.</P>
        <L items={[
          "Installing asks for the connections and a few settings, such as who receives a report. The result is a normal agent or workflow you can change.",
          "Installed workflows start as Drafts and have no schedule until you add one.",
          "Customise saves your own version of a template, such as different wording or a different schedule, for your team to install.",
        ]} />
      </>
    ),
  },
  {
    id: "people", title: "People and roles", icon: Users,
    words: "people roles invite owner admin builder operator viewer permission member",
    body: (to) => (
      <>
        <P>Invite people in <Go to={to("/settings#people")}>Settings</Go>. Each person has one role in each workspace.</P>
        <dl className="mb-3">
          <Term name="Viewer">Sees agents, workflows, runs and results. Cannot start or approve anything.</Term>
          <Term name="Operator">Chats with agents, runs workflows and approves. The right role for most staff.</Term>
          <Term name="Builder">Also creates and changes agents and workflows.</Term>
          <Term name="Admin">Also manages people, connections and secrets, and reads the audit log.</Term>
          <Term name="Owner">Everything, including billing and deleting the workspace.</Term>
        </dl>
      </>
    ),
  },
  {
    id: "safety", title: "Safety and control", icon: ShieldCheck,
    words: "safety pause all turn off agent kill switch release gate tests untested failed use it anyway loop runaway budget allowance audit log confidential privacy data cost usage limit",
    body: (to) => (
      <>
        <L items={[
          <><b>Pause all</b>, on the Overview, stops every workflow and chat in the workspace at once. Runs hold where they are and carry on after an admin presses Resume.</>,
          <><b>Turn off one agent</b> from its page when only that agent is misbehaving. It starts no chat replies, workflow steps or hand-offs until someone who manages agents turns it on again. Anyone who can approve work can turn an agent off.</>,
          <><b>A changed agent is tested before workflows use it.</b> If an agent has saved tests (the Tests button on its page), changing it starts them at once. Until they pass, live workflows will not use the new version: a step that needs it stops with a message naming the tests that failed. Chats with the agent still work, and its page and the Agents list show where the tests stand. If a test is out of date, an admin can choose Use it anyway; that is recorded in the audit log, and the next change is tested again.</>,
          <><b>Agents cannot act beyond what they were given.</b> An agent only has the actions you connected to it. Reading runs freely, anything that changes data waits for a person, and an admin can make any action stricter under <Go to={to("/connections")}>Connections</Go>, Rules.</>,
          <><b>Runaway work is stopped.</b> Each run has a step and token limit, and an agent that asks for the same step with the same details a third time is stopped before it spends more.</>,
          <><b>A monthly AI allowance</b> caps what the workspace can spend. Everyone sees a warning from 80% used, and an admin can change the limit in Settings.</>,
          <><b>Approvals</b> stand between an agent and anything that leaves the building.</>,
          <><b>The audit log</b> records who did what and when: sign-ins, changes, approvals. Admins find it under <Go to={to("/audit")}>Audit log</Go>.</>,
          <><b>Confidential mode</b>, under Data rules in Settings, keeps work on AI providers you have cleared for confidential data.</>,
          <><b>Instructions hidden in data are ignored.</b> If an email or document tells an agent to do something, the agent treats it as text, not as an order.</>,
          <><b>Usage and costs</b> shows what each agent and workflow spends, so there are no surprises. See <Go to={to("/observability")}>Usage and costs</Go>.</>,
        ]} />
      </>
    ),
  },
  {
    id: "account", title: "Your account", icon: KeyRound,
    words: "account password two-step 2fa authenticator sign in backup code lost phone",
    body: (to) => (
      <>
        <L items={[
          <><b>Two-step sign-in</b> is on by default: after your password, you enter a code from an authenticator app. You can turn it off for your own account in <Go to={to("/settings#account")}>Settings, Your account</Go>, but it is much safer left on.</>,
          "Keep your backup codes somewhere safe. If you lose your phone, sign in with a backup code and tick \"I lost my authenticator\" to set up a new one.",
          "Forgot your password? Use the link on the sign-in page. It needs mail to be set up on this server, otherwise ask an admin.",
          <>Press <kbd className="rounded border border-line bg-raised px-1 text-[12px]">Ctrl</kbd> + <kbd className="rounded border border-line bg-raised px-1 text-[12px]">K</kbd> (<kbd className="rounded border border-line bg-raised px-1 text-[12px]">⌘</kbd> + <kbd className="rounded border border-line bg-raised px-1 text-[12px]">K</kbd> on a Mac) anywhere to jump to any page.</>,
        ]} />
      </>
    ),
  },
  {
    id: "questions", title: "Common questions", icon: HelpCircle,
    words: "question problem error failed slow wrong answer not working faq troubleshoot",
    body: (to) => (
      <>
        <dl>
          <Term name="The answer looks wrong">Ask the agent where it got it, or open the chat's Timeline to see what it read. Agents only use your data. If the data is missing, they say so instead of guessing.</Term>
          <Term name="A run failed">Open it. The failed step is marked, with the reason in plain words. Often it is a connection that needs a new password or a model key that ran out.</Term>
          <Term name="Nothing happens on schedule">Check the workflow is Live, not Draft, and has a schedule under Triggers. Times are in the time zone shown on the schedule.</Term>
          <Term name="A report was not emailed">It is probably waiting for approval. Look in <Go to={to("/approvals")}>Approvals</Go>.</Term>
          <Term name="An agent cannot find a file">Make sure the file is in <Go to={to("/files")}>Files</Go> and shows Ready under Search, and that the agent uses your documents or files.</Term>
          <Term name="It is slow">Long reports over a lot of data take longer. Ask for a narrower range, such as one plant or this month.</Term>
        </dl>
      </>
    ),
  },
];

/** The user guide: how the parts fit, and how to use each one, written for the people who use it. */
export function Help() {
  const { link } = useWorkspace();
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return TOPICS.filter((topic) => words.every((word) => `${topic.title} ${topic.words}`.toLowerCase().includes(word)));
  }, [query]);
  const jump = (id: string) => document.getElementById(`help-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  return (
    <>
      <PageHeader icon={HelpCircle} title="Help" description="How the app works, and how to get the most from it." />
      <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
        <nav aria-label="Help topics" className="lg:sticky lg:top-4 lg:self-start">
          <div className="relative mb-2">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <Input aria-label="Search help" placeholder="Search help" className="pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <ul className="flex flex-wrap gap-1 lg:block lg:space-y-0.5">
            {shown.map((topic) => (
              <li key={topic.id}>
                <button type="button" onClick={() => jump(topic.id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] text-muted hover:bg-sunken hover:text-ink">
                  <topic.icon size={14} className="shrink-0" /> {topic.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-3">
          {shown.length === 0 && <Card className="p-5 text-[13px] text-muted">Nothing matches that. Try one word, such as "schedule" or "approve".</Card>}
          {shown.map((topic) => (
            <Card key={topic.id} className="scroll-mt-4 p-5 text-[14px]">
              <section id={`help-${topic.id}`} className="scroll-mt-4">
                <h2 className="mb-3 flex items-center gap-2 text-[16px] font-semibold"><topic.icon size={17} className="text-accent" /> {topic.title}</h2>
                {topic.body(link)}
              </section>
            </Card>
          ))}
          <p className="flex items-center gap-1.5 px-1 pb-4 text-[12px] text-faint"><LifeBuoy size={12} /> Something missing from this guide? Tell your administrator, so it can be added.</p>
        </div>
      </div>
    </>
  );
}
