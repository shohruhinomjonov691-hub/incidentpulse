import { expect, test } from "vitest";
import { buildIncidentGraph } from "../src/index.ts";
import { makeMocks } from "./helpers.ts";

test("the graph has the Phase 2 nodes (triage, fan-out investigate, join) plus escalate", () => {
  const graph = buildIncidentGraph(makeMocks().deps);
  const nodes = Object.keys(graph.getGraph().nodes).filter((n) => !n.startsWith("__"));
  expect(nodes.sort()).toEqual([
    "escalate",
    "intake",
    "investigate",
    "join",
    "report",
    "synthesize",
    "triage",
  ]);
});
