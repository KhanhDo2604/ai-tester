import { CDPSession } from "playwright";

export interface RawAXNode {
  nodeId: string;
  role?: string;
  name?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  properties: Record<string, unknown>;
}

/**
 * Reads the full accessibility tree via the raw CDP Accessibility domain,
 * not Playwright's page.accessibility.snapshot(). Unlike the high-level
 * API, CDP's raw AXNode carries a `backendDOMNodeId` — a real, stable link
 * to the exact DOM element behind each accessibility node. That link is
 * what lets graph/buildGraph.ts fetch real DOM attributes for the correct
 * element directly in describeDomNode(), with no position-based guessing.
 *
 * `client` must already have Accessibility.enable called on it —
 * graph/buildGraph.ts owns the CDP session and enables both domains it
 * needs (Accessibility and DOM) once, up front.
 *
 * Returns CDP's native flat shape: a list of nodes referencing each other
 * by nodeId/childIds, not yet assembled into a tree — buildGraph.ts does
 * that assembly.
 */
export async function extractAccessibilityTree(
  client: CDPSession,
): Promise<RawAXNode[]> {
  const { nodes } = await client.send("Accessibility.getFullAXTree" as any);

  return (nodes as any[]).map((node) => ({
    nodeId: node.nodeId,
    role: node.role?.value,
    name: node.name?.value,
    childIds: node.childIds,
    backendDOMNodeId: node.backendDOMNodeId,
    properties: Object.fromEntries(
      (node.properties ?? []).map((p: any) => [p.name, p.value?.value]),
    ),
  }));
}
