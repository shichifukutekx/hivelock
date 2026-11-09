// Runs a test file with no edition limits, so a test of something else need not stay under them.
// With the paid package that is a real licence key. Without it the test stands in for the package, through the one interface any package uses.
import { existsSync } from "node:fs";
import { extensions, loadExtensions, registerExtension } from "../src/platform/extensions.ts";
import { COMMUNITY, type Edition } from "../src/platform/plans.ts";

const paid = new URL("../ee/test/licensed.ts", import.meta.url);
await loadExtensions();
if (existsSync(paid)) await import(paid.href);
else if (!extensions().length) {
  const unlimited: Edition = { id: "licensed", name: "Test", limits: { ...COMMUNITY, workspaces: null, people: null, agents: null, workflows: null, storageBytes: null, connectors: null, lockedFeatures: [] } };
  registerExtension({ name: "test-unlimited", edition: { current: async () => unlimited, upgrade: "Not reachable in these tests." } });
}
