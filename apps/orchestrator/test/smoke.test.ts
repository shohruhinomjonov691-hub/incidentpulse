import { expect, test } from "vitest";
import { buildIncidentGraph } from "../src/index.ts";
import { makeMocks } from "./helpers.ts";

test("the graph has the intake, debate, approval, execution and recovery nodes", () => {
  const graph = buildIncidentGraph(makeMocks().deps);
  const nodes = Object.keys(graph.getGraph().nodes).filter((n) => !n.startsWith("__"));
  expect(nodes.sort()).toEqual([
    "await_approval",
    "close",
    "escalate",
    "execute",
    "intake",
    "investigate",
    "join",
    "propose",
    "reinvestigate",
    "report",
    "request_approval",
    "synthesize",
    "transient",
    "triage",
    "verify",
    "verify_recovery",
  ]);
});
