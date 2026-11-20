import { expect, test } from "vitest";
import { buildIncidentGraph } from "../src/index.ts";
import { makeMocks } from "./helpers.ts";

test("the graph has exactly the Phase 1 nodes", () => {
  const graph = buildIncidentGraph(makeMocks().deps);
  const nodes = Object.keys(graph.getGraph().nodes).filter((n) => !n.startsWith("__"));
  expect(nodes.sort()).toEqual(["infra_specialist", "intake", "report", "synthesize"]);
});
