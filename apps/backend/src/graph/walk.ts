import { UISemanticGraphNode } from "./types";

/**
 * Depth-first traversal that also hands each visitor the chain of
 * ancestors, so rules can ask structural questions like "is this button
 * inside a form" or "is this link inside the navigation landmark".
 */
export function walk(
  node: UISemanticGraphNode,
  visit: (node: UISemanticGraphNode, ancestors: UISemanticGraphNode[]) => void,
  ancestors: UISemanticGraphNode[] = [],
): void {
  visit(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const child of node.children) {
    walk(child, visit, nextAncestors);
  }
}

/**
 * Normalizes text for comparison and display. Icon fonts (Font Awesome and
 * similar) render glyphs from the Unicode Private Use Area through CSS,
 * and Chromium includes them in accessible names — so a "Login" button
 * with a sign-in icon is named " Login". Those glyphs carry no
 * meaning for a reader, so they are removed here.
 *
 * Only used for comparing and reporting. Locating an element keeps the raw
 * label, since Playwright matches against the same raw accessible name.
 */
export function cleanText(text: string | undefined): string {
  return (text ?? "").replace(/[-]/g, "").replace(/\s+/g, " ").trim();
}

/** All human-readable text of a node: its own label plus every labelled descendant. */
export function textContent(node: UISemanticGraphNode): string {
  const parts: string[] = [];
  walk(node, (n) => {
    const label = cleanText(n.label);
    if (label) parts.push(label);
  });
  return parts.join(" ").trim();
}
