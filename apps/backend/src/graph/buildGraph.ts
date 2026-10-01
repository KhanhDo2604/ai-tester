import { Page } from "playwright";
import {
  extractAccessibilityTree,
  RawAXNode,
} from "../extraction/accessibilityTree.js";
import { describeDomNode } from "../extraction/domSubset.js";
import { UISemanticGraph, UISemanticGraphNode } from "./types.js";

const ROLE_TO_TYPE: Record<string, UISemanticGraphNode["type"]> = {
  form: "form",
  textbox: "input",
  combobox: "input",
  checkbox: "input",
  radio: "input",
  button: "button",
  link: "link",
  heading: "heading",
  dialog: "dialog",
  alert: "alert",
};

function normalizeType(role?: string): UISemanticGraphNode["type"] {
  return (role ? ROLE_TO_TYPE[role] : undefined) ?? "container";
}

/** The root is whichever node is never listed as someone else's child. */
function findRoot(flatNodes: RawAXNode[]): RawAXNode | undefined {
  const childIds = new Set(flatNodes.flatMap((n) => n.childIds ?? []));
  return flatNodes.find((n) => !childIds.has(n.nodeId));
}

/**
 * Builds the UI Semantic Graph for the page's current state — see README
 * Section 3.
 *
 * Correlation strategy: every accessibility node that corresponds to a
 * real DOM element carries CDP's `backendDOMNodeId` (extraction/
 * accessibilityTree.ts). This function uses that id directly, via
 * describeDomNode(), to fetch that exact element's attributes — a true
 * one-to-one join, not position-based matching. It no longer matters
 * whether two separate passes agree on what counts as "interesting":
 * there is only one pass now, and every node's domExtra, when present, is
 * guaranteed to belong to that specific node.
 */
export async function buildUISemanticGraph(
  page: Page,
): Promise<UISemanticGraph> {
  const client = await page.context().newCDPSession(page);
  await client.send("DOM.enable" as any);
  await client.send("Accessibility.enable" as any);

  const flatNodes = await extractAccessibilityTree(client);
  const byId = new Map(flatNodes.map((n) => [n.nodeId, n]));

  const domCache = new Map<
    number,
    Awaited<ReturnType<typeof describeDomNode>>
  >();
  async function getDomInfo(backendDOMNodeId?: number) {
    if (backendDOMNodeId === undefined) return undefined;
    if (!domCache.has(backendDOMNodeId)) {
      domCache.set(
        backendDOMNodeId,
        await describeDomNode(client, backendDOMNodeId),
      );
    }
    return domCache.get(backendDOMNodeId) ?? undefined;
  }

  async function build(node: RawAXNode): Promise<UISemanticGraphNode> {
    const domInfo = await getDomInfo(node.backendDOMNodeId);
    const children = await Promise.all(
      (node.childIds ?? [])
        .map((id) => byId.get(id))
        .filter((n): n is RawAXNode => Boolean(n))
        .map(build),
    );

    return {
      id: node.nodeId,
      type: normalizeType(node.role),
      role: node.role ?? "unknown",
      label: node.name,
      state: {
        required: node.properties.required as boolean | undefined,
        invalid: node.properties.invalid as boolean | undefined,
        disabled: node.properties.disabled as boolean | undefined,
        checked: node.properties.checked as boolean | undefined,
        expanded: node.properties.expanded as boolean | undefined,
      },
      domExtra: domInfo
        ? {
            href: domInfo.href,
            inputType: domInfo.inputType,
            hidden: domInfo.hidden,
          }
        : undefined,
      children,
    };
  }

  const rootRaw = findRoot(flatNodes);
  if (!rootRaw) {
    throw new Error(
      "Page has no accessible root — nothing to build a graph from.",
    );
  }

  const root = await build(rootRaw);

  return { route: new URL(page.url()).pathname, root };
}
