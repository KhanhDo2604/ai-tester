import { Page } from "playwright";
import { extractAccessibilityTree, RawAXNode } from "./accessibilityTree";
import { describeDomNode } from "./domSubset";
import { UISemanticGraph, UISemanticGraphNode } from "../../graph/types";

const ROLE_TO_TYPE: Record<string, UISemanticGraphNode["type"]> = {
  form: "form",
  textbox: "input",
  searchbox: "input",
  spinbutton: "input",
  combobox: "input",
  checkbox: "input",
  radio: "input",
  button: "button",
  link: "link",
  heading: "heading",
  dialog: "dialog",
  alertdialog: "dialog",
  alert: "alert",
  status: "alert",
};

/** Visible text content. Kept as a "text" node unless it duplicates its parent's name. */
const TEXT_ROLE = "StaticText";

/** Rendering internals with no testing meaning — always dropped. */
const DROPPED_ROLES = new Set(["InlineTextBox", "LineBreak"]);

/** Purely structural wrappers with no testing meaning — collapsed, children hoisted. */
const TRANSPARENT_ROLES = new Set([
  "none",
  "generic",
  "paragraph",
  "LabelText",
]);

/** Links are stored as absolute URLs, so nothing downstream needs the page to resolve them. */
function absoluteHref(
  href: string | undefined,
  base: string,
): string | undefined {
  if (href === undefined) return undefined;
  try {
    return new URL(href, base).href;
  } catch {
    return undefined;
  }
}

function normalizeType(role?: string): UISemanticGraphNode["type"] {
  return (role ? ROLE_TO_TYPE[role] : undefined) ?? "container";
}

/**
 * CDP's accessibility properties aren't consistently real booleans — e.g.
 * "invalid" is backed by aria-invalid, whose values are actually
 * "false" | "true" | "grammar" | "spelling" (strings), so a node that is
 * NOT invalid can come back as the literal string "false", which is
 * truthy in JS. Centralizing the conversion here means every state field
 * is read the same way instead of silently misreading a string as true.
 *
 * Known simplification: a tri-state value like "mixed" (for `checked`)
 * collapses to `true` under this rule rather than being modeled
 * separately — acceptable for the MVP's contracts, revisit if a contract
 * ever needs to distinguish "mixed" from "checked".
 */
function toBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value !== "false" && value !== "";
  return Boolean(value);
}

/**
 * Collapses structurally meaningless nodes so the graph reflects
 * testing-relevant structure (README Section 3's "form → input/button"
 * shape), not every wrapper the renderer happens to produce. Mutates and
 * returns `node`.
 *
 * Text handling: a text node is dropped when its parent's accessible name
 * already contains it (a button's or link's own label), and kept as a
 * "text" node otherwise — that is how messages like "No tasks yet." or an
 * inline "Title is required" stay visible to the State Signature.
 *
 * Input internals are dropped entirely: a textbox renders its current
 * value as text inside itself, and keeping that would make typed values
 * look like newly appeared messages.
 */
function pruneChildren(node: UISemanticGraphNode): UISemanticGraphNode {
  if (node.type === "input") {
    node.children = [];
    return node;
  }

  const prunedChildren: UISemanticGraphNode[] = [];

  for (const child of node.children) {
    if (DROPPED_ROLES.has(child.role)) continue;

    if (child.role === TEXT_ROLE) {
      const text = child.label?.trim();
      if (!text) continue;
      // <label> text is kept too. It often repeats a field's name, but not
      // always: TodoMVC renders each todo's text in a <label> that names
      // no field, and dropping it hid the very item an action had created.
      // Repeated field names are harmless downstream, since they appear in
      // both the before and the after signature and cancel out in the diff.
      if (node.label && node.label.includes(text)) continue;
      prunedChildren.push({
        ...child,
        type: "text",
        label: text,
        domExtra: undefined,
        children: [],
      });
      continue;
    }

    const prunedChild = pruneChildren(child);

    if (
      TRANSPARENT_ROLES.has(prunedChild.role) &&
      prunedChild.type === "container"
    ) {
      prunedChildren.push(...prunedChild.children); // hoist grandchildren up
    } else {
      prunedChildren.push(prunedChild);
    }
  }

  node.children = prunedChildren;
  return node;
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
 * one-to-one join, not position-based matching.
 */
export async function buildUISemanticGraph(
  page: Page,
): Promise<UISemanticGraph> {
  const client = await page.context().newCDPSession(page);

  try {
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
        // A node can disappear between the AX snapshot and this call on a
        // page that is still rendering; treat that as "no DOM info".
        const info = await describeDomNode(client, backendDOMNodeId).catch(
          () => null,
        );
        domCache.set(backendDOMNodeId, info);
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
        // Chromium versions disagree on the role of a <form> without an
        // accessible name ("form" in some, "generic" in others), so the
        // DOM tag decides — a form must never be collapsed as a wrapper.
        type: domInfo?.tag === "form" ? "form" : normalizeType(node.role),
        role: node.role ?? "unknown",
        label: node.name?.trim(),
        state: {
          required: toBool(node.properties.required),
          invalid: toBool(node.properties.invalid),
          disabled: toBool(node.properties.disabled),
          checked: toBool(node.properties.checked),
          expanded: toBool(node.properties.expanded),
        },
        domExtra: domInfo
          ? {
              tag: domInfo.tag || undefined,
              href: absoluteHref(domInfo.href, page.url()),
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

    const root = pruneChildren(await build(rootRaw));

    return { route: new URL(page.url()).pathname, root };
  } finally {
    // One CDP session per capture; Phase 2 captures many times per page,
    // so leaving them attached would leak sessions across a scan.
    await client.detach().catch(() => {});
  }
}
