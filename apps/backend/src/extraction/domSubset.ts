import { CDPSession } from "playwright";

export interface DomInfo {
  tag: string;
  href?: string;
  inputType?: string;
  hidden?: boolean;
}

/**
 * Fetches real DOM attributes for one exact element, identified by its CDP
 * backendDOMNodeId — the id every node from extraction/accessibilityTree.ts
 * carries. This replaces the earlier position-matching approach entirely:
 * there's no guessing about which DOM element a given accessibility node
 * corresponds to, because CDP already tells us directly.
 *
 * `client` must already have DOM.enable called on it.
 *
 * Note on `hidden`: this only checks the HTML `hidden` attribute, not
 * computed CSS (e.g. display: none from a stylesheet rule). Getting
 * computed style from raw CDP needs the CSS domain plus an extra node-id
 * resolution step, which is left out here since most apps toggle
 * visibility via the `hidden` attribute or conditional rendering rather
 * than a stylesheet rule. Revisit this if a real page relies on
 * CSS-driven hiding and that turns out to matter for a contract.
 */
export async function describeDomNode(
  client: CDPSession,
  backendNodeId: number,
): Promise<DomInfo | null> {
  const { node } = await client.send(
    "DOM.describeNode" as any,
    { backendNodeId } as any,
  );
  if (!node) return null;

  const attrs = toAttrMap(node.attributes ?? []);

  return {
    tag: node.nodeName?.toLowerCase() ?? "",
    href: attrs.href,
    inputType: attrs.type,
    hidden: "hidden" in attrs ? true : undefined,
  };
}

/** CDP returns attributes as a flat array: [name, value, name, value, ...]. */
function toAttrMap(attributes: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < attributes.length; i += 2) {
    map[attributes[i]] = attributes[i + 1];
  }
  return map;
}
