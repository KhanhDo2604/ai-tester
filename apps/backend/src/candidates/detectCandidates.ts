import { locationOf, StatePath } from "../driver/types";
import { UISemanticGraph, UISemanticGraphNode } from "../graph/types";
import { cleanText, walk } from "../graph/walk";
import { formatKind } from "../execution/fillValues";
import {
  Candidate,
  ContractName,
  ControlTarget,
  DeferredControl,
  FieldTarget,
  Grouping,
  SessionKind,
  Strategy,
  SubmitMode,
} from "./types";

/** Roles the executor knows how to fill or toggle. */
const FILLABLE_ROLES = new Set([
  "textbox",
  "searchbox",
  "spinbutton",
  "combobox",
  "checkbox",
]);

/** Roles that take typed text — an interaction needs at least one to be worth testing. */
const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "spinbutton"]);

/** Landmarks whose content repeats across pages. */
const PERSISTENT_REGION_ROLES = new Set(["navigation", "banner"]);

const CONTRACTS_BY_STRATEGY: Record<Strategy, ContractName[]> = {
  emptySubmit: ["FormValidationFeedback", "NoServerError"],
  validSubmit: ["ActionFeedback", "StateConsistency", "NoServerError"],
  invalidFormat: ["FormatValidation", "NoServerError"],
};

interface InteractionGroup {
  formName: string;
  grouping: Grouping;
  submitMode: SubmitMode;
  fields: FieldTarget[];
  submit?: ControlTarget;
  strategies: Strategy[];
}

function isFillable(node: UISemanticGraphNode): boolean {
  // Unlabelled fields can't be targeted by role + name. They are an
  // accessibility issue in their own right (UX Heuristic Engine, Phase 5).
  return FILLABLE_ROLES.has(node.role) && Boolean(node.label);
}

function toField(node: UISemanticGraphNode): FieldTarget {
  return {
    role: node.role,
    label: node.label!,
    inputType: node.domExtra?.inputType,
    tag: node.domExtra?.tag,
    disabled: node.state.disabled === true,
  };
}

/** Disabled fields don't count: a group a user can't type into isn't an interaction. */
function hasTextEntry(fields: FieldTarget[]): boolean {
  return fields.some((f) => TEXT_ENTRY_ROLES.has(f.role) && !f.disabled);
}

/**
 * Interaction Candidate Detection — deterministic rules, README Section 4.
 *
 * Four rules, all structural, none app-specific:
 *
 * 1. Form: a <form> with at least one text field and a button. Yields
 *    emptySubmit and validSubmit.
 *
 * 2. Adjacent group: text fields outside any <form> that are immediately
 *    followed by a button in the same container (only text in between).
 *    Many apps never use <form>; this recovers those interactions without
 *    pairing a field with some unrelated button further down the page.
 *    Yields emptySubmit and validSubmit.
 *
 * 3. Single field: a text field outside any <form> with no button next to
 *    it, committed by pressing Enter (todo entry, search). Yields only
 *    validSubmit: with no visible submit control, silently ignoring an
 *    empty Enter is the established convention, so testing it for
 *    "missing validation feedback" would produce false positives.
 *    Multi-line text areas are skipped, since Enter inserts a newline there.
 *
 * 4. Format check: any form or adjacent group (rules 1 and 2) that has an
 *    editable email or URL field additionally yields invalidFormat, which
 *    submits a malformed value in that field and valid values elsewhere.
 *
 * Deliberate difference from the README's rule table ("a form with a
 * required field"): many apps enforce required fields in JavaScript
 * without setting `required` / `aria-required`, so the attribute can't be
 * trusted. Every group is tested, and Contract Check returns AMBIGUOUS
 * when an empty submission is accepted (all fields optional).
 */
export function detectCandidates(
  graph: UISemanticGraph,
  session: SessionKind,
  path: StatePath = { entry: graph.route, steps: [] },
): { candidates: Candidate[]; deferred: DeferredControl[] } {
  const location = locationOf(path);
  const groups: InteractionGroup[] = [];
  const coveredButtons = new Set<string>();

  // Rule 1 — real forms.
  walk(graph.root, (node) => {
    if (node.type !== "form") return;

    const fields: FieldTarget[] = [];
    const buttons: UISemanticGraphNode[] = [];
    walk(node, (descendant) => {
      if (descendant === node) return;
      if (isFillable(descendant)) fields.push(toField(descendant));
      if (descendant.type === "button" && descendant.label)
        buttons.push(descendant);
    });

    const submitNode =
      buttons.find((b) => b.domExtra?.inputType === "submit") ??
      buttons[buttons.length - 1];
    // A form with no text fields (e.g. a lone "Log out" button wrapped in a
    // form) is really a standalone action — its button stays deferred.
    if (!submitNode || !hasTextEntry(fields)) return;

    buttons.forEach((b) => coveredButtons.add(b.id));
    groups.push({
      formName: cleanText(node.label) || cleanText(submitNode.label),
      grouping: "form",
      submitMode: "click",
      fields,
      submit: { role: submitNode.role, label: submitNode.label! },
      strategies: ["emptySubmit", "validSubmit"],
    });
  });

  // Rules 2 and 3 — fields outside forms, scanned container by container.
  function scanOutsideForms(container: UISemanticGraphNode): void {
    if (container.type === "form" || container.type === "input") return;

    let pending: FieldTarget[] = [];

    const flushAsSingleFields = () => {
      for (const field of pending) {
        if (
          !TEXT_ENTRY_ROLES.has(field.role) ||
          field.tag === "textarea" ||
          field.disabled
        )
          continue;
        groups.push({
          formName: cleanText(field.label),
          grouping: "single",
          submitMode: "enter",
          fields: [field],
          strategies: ["validSubmit"],
        });
      }
      pending = [];
    };

    for (const child of container.children) {
      if (isFillable(child)) {
        pending.push(toField(child));
        continue;
      }
      if (child.type === "text") continue; // labels and hints between fields don't break a group

      if (child.type === "button" && child.label && hasTextEntry(pending)) {
        coveredButtons.add(child.id);
        groups.push({
          formName: cleanText(child.label),
          grouping: "adjacent",
          submitMode: "click",
          fields: pending,
          submit: { role: child.role, label: child.label },
          strategies: ["emptySubmit", "validSubmit"],
        });
        pending = [];
        continue;
      }

      flushAsSingleFields();
      scanOutsideForms(child);
    }

    flushAsSingleFields();
  }
  scanOutsideForms(graph.root);

  const candidates: Candidate[] = groups.flatMap((group) => {
    const passwordFields = group.fields.filter(
      (f) => f.inputType === "password",
    ).length;
    const textEntryFields = group.fields.filter((f) =>
      TEXT_ENTRY_ROLES.has(f.role),
    ).length;
    const isCredentialForm = passwordFields === 1 && textEntryFields === 2;

    // Rule 4 — format check. Only for groups that have an editable field
    // with a known format. Disabled fields don't count: a user can't type
    // into them (e.g. an email field locked on a profile page by design).
    // Credential forms are skipped: a login form rejecting a malformed
    // email looks exactly like it rejecting wrong credentials, so the
    // check would say nothing about format validation there.
    const hasEditableFormatField = group.fields.some(
      (f) => !f.disabled && formatKind(f) !== undefined,
    );
    const strategies: Strategy[] =
      group.submitMode === "click" &&
      hasEditableFormatField &&
      !isCredentialForm
        ? [...group.strategies, "invalidFormat"]
        : group.strategies;

    return strategies.map((strategy) => ({
      id: `${location} :: ${group.formName} :: ${strategy}`,
      kind: "formSubmit" as const,
      route: graph.route,
      path,
      session,
      strategy,
      contracts: CONTRACTS_BY_STRATEGY[strategy],
      formName: group.formName,
      grouping: group.grouping,
      submitMode: group.submitMode,
      fields: group.fields,
      submit: group.submit,
      isCredentialForm,
    }));
  });

  const pageHeadings: string[] = [];
  walk(graph.root, (node) => {
    const heading = cleanText(node.label);
    if (node.type === "heading" && heading) pageHeadings.push(heading);
  });

  const deferred: DeferredControl[] = [];
  walk(graph.root, (node, ancestors) => {
    if (node.type !== "button" || !node.label || coveredButtons.has(node.id))
      return;
    deferred.push({
      route: graph.route,
      path,
      session,
      role: node.role,
      label: node.label,
      region: ancestors.some((a) => PERSISTENT_REGION_ROLES.has(a.role))
        ? "persistent"
        : "page",
      pageHeadings,
      reason:
        "Standalone action — needs Semantic Contract Discovery (Phase 3) to decide what it should do and whether it is safe to execute.",
    });
  });

  return { candidates, deferred };
}
