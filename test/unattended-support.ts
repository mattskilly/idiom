import type {
  AutobuildTracker,
  TrackerTicket,
} from "../src/nightly/autobuild.js";

/** An in-memory autobuild tracker that records every call. */
export function memoryTracker(
  options: { triage?: string[]; failCreate?: boolean } = {},
) {
  const tickets: TrackerTicket[] = [];
  const calls: string[] = [];
  let next = 1;
  const tracker: AutobuildTracker = {
    async triageStates() {
      calls.push("states");
      return options.triage ?? ["triage"];
    },
    async listLabelled(label) {
      calls.push("list");
      return tickets.filter((ticket) => ticket.labels.includes(label));
    },
    async show(id) {
      calls.push("show");
      return tickets.find((ticket) => ticket.ref.id === id);
    },
    async create({ title, body, state, labels }) {
      calls.push("create");
      if (options.failCreate) throw new Error("tracker unavailable");
      const ticket: TrackerTicket = {
        ref: { id: `file-${next++}` },
        title,
        state,
        resolved: false,
        labels: [...labels],
        body,
      };
      tickets.push(ticket);
      return ticket;
    },
    async update({ id, body, labels }) {
      calls.push("update");
      const ticket = tickets.find((entry) => entry.ref.id === id);
      if (ticket === undefined) throw new Error(`no ticket ${id}`);
      ticket.body = body;
      ticket.labels = [...labels];
      return ticket;
    },
  };
  return { tracker, tickets, calls };
}

/** A store-backed fake `ab` on PATH; returns its environment and tickets. */
export async function fakeAbBin(directory: string) {
  const { chmod, readFile, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const store = join(directory, "store.json");
  await writeFile(
    store,
    JSON.stringify({
      states: [{ name: "Inbox", roles: ["create", "triage"] }],
      tickets: [],
      next: 1,
      verbs: [],
    }),
  );
  await writeFile(
    join(directory, "ab"),
    `#!${process.execPath}
const fs = require("node:fs");
const [, , group, verb, ...rest] = process.argv;
const store = JSON.parse(fs.readFileSync(process.env.AB_STORE, "utf8"));
store.verbs.push(verb);
const save = () => fs.writeFileSync(process.env.AB_STORE, JSON.stringify(store));
const flag = (name) => { const i = rest.indexOf(name); return i === -1 ? undefined : rest[i + 1]; };
const print = (value) => { save(); process.stdout.write(JSON.stringify(value)); };
if (verb === "states") print(store.states);
else if (verb === "list") print(store.tickets.filter((t) => t.labels.includes(flag("--labels"))));
else if (verb === "show" || verb === "update") {
  const ticket = store.tickets.find((t) => t.ref.id === rest[0]);
  if (!ticket) { save(); process.stderr.write("no ticket " + rest[0]); process.exit(1); }
  if (verb === "update") { ticket.body = fs.readFileSync(flag("--body"), "utf8"); ticket.labels = flag("--labels").split(",").filter(Boolean); }
  print(ticket);
} else if (verb === "create") {
  const ticket = { ref: { source: "file", id: "file-" + store.next++ }, title: rest[0], body: fs.readFileSync(flag("--body"), "utf8"), state: flag("--state"), resolved: false, labels: flag("--labels").split(",").filter(Boolean) };
  store.tickets.push(ticket);
  print(ticket);
} else { save(); process.exit(2); }
`,
  );
  await chmod(join(directory, "ab"), 0o755);
  return {
    environment: {
      PATH: `${directory}:/usr/bin:/bin`,
      AB_STORE: store,
    } as NodeJS.ProcessEnv,
    store: async () =>
      JSON.parse(await readFile(store, "utf8")) as {
        tickets: Array<{
          ref: { id: string };
          title: string;
          body: string;
          state: string;
          labels: string[];
        }>;
        verbs: string[];
      },
  };
}
