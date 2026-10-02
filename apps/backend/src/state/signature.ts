import { Page } from "playwright";
import { buildUISemanticGraph } from "../graph/buildGraph";
import { UISemanticGraph } from "../graph/types";
import { cleanText, textContent, walk } from "../graph/walk";
import { NetworkTracker } from "../execution/network";

export interface FieldState {
  label: string;
  invalid: boolean;
  disabled: boolean;
}

export interface ControlState {
  label: string;
  disabled: boolean;
}

/**
 * Semantic State Signature — README Section 6. A structured, field-level
 * snapshot of the state that matters, so two signatures can be compared
 * field by field and produce a concrete delta.
 */
export interface StateSignature {
  route: string;
  headings: string[];
  /**
   * Labels inside persistent page regions (navigation and banner
   * landmarks). These are expected to reflect app-wide state such as "who
   * is logged in", which is what State Consistency compares.
   */
  navigation: string[];
  /** Text of alert / status regions. */
  alerts: string[];
  /** Every visible text node, including alert text. */
  texts: string[];
  dialogs: string[];
  fields: FieldState[];
  buttons: ControlState[];
}

const PERSISTENT_REGION_ROLES = new Set(["navigation", "banner"]);

export function signatureFromGraph(graph: UISemanticGraph): StateSignature {
  const signature: StateSignature = {
    route: graph.route,
    headings: [],
    navigation: [],
    alerts: [],
    texts: [],
    dialogs: [],
    fields: [],
    buttons: [],
  };

  walk(graph.root, (node, ancestors) => {
    const label = cleanText(node.label);

    const inPersistentRegion = ancestors.some((a) =>
      PERSISTENT_REGION_ROLES.has(a.role),
    );
    if (
      inPersistentRegion &&
      label &&
      ["link", "button", "text"].includes(node.type)
    ) {
      signature.navigation.push(label);
    }

    switch (node.type) {
      case "heading":
        if (label) signature.headings.push(label);
        break;
      case "alert": {
        const text = textContent(node);
        if (text) signature.alerts.push(text);
        break;
      }
      case "text":
        if (label) signature.texts.push(label);
        break;
      case "dialog":
        signature.dialogs.push(label || "(unnamed dialog)");
        break;
      case "input":
        signature.fields.push({
          label,
          invalid: node.state.invalid === true,
          disabled: node.state.disabled === true,
        });
        break;
      case "button":
        signature.buttons.push({
          label,
          disabled: node.state.disabled === true,
        });
        break;
    }
  });

  return signature;
}

/** Waits for the page to settle, then captures its signature. */
export async function captureSignature(
  page: Page,
  network: NetworkTracker,
): Promise<StateSignature> {
  await network.settle();
  const graph = await buildUISemanticGraph(page);
  return signatureFromGraph(graph);
}
