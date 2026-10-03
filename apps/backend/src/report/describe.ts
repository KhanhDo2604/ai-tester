import { Candidate, FieldTarget } from "../candidates/types";
import { ClassifiedAction } from "../discovery/types";
import { formatKind } from "../execution/fillValues";
import { EXPECTATIONS } from "../findings/judge";
import { Finding, subjectName, subjectRoute } from "../findings/types";
import { cleanText } from "../graph/walk";

export interface Description {
  summary: string;
  steps: string[];
  expected: string;
  actual: string;
}

const LOGIN_STEP = "Log in with the test account";

/** Evidence lines that are engine notes rather than observations. */
const NOTE =
  /^(reproduced|not reproduced|hypothesis|judged by|reference:|present again|not present|whether this text|axe-core rule|seen in)/;

export function describe(f: Finding): Description {
  if (f.source === "heuristic") return describeHeuristic(f);

  const subject = f.results[0].subject;
  const name = subjectName(subject);
  const route = subjectRoute(subject);
  const observed = f.evidence.filter((e) => !NOTE.test(e));
  const steps =
    subject.kind === "form"
      ? formSteps(subject.candidate)
      : actionSteps(subject.action);

  if (f.key.startsWith("server::")) {
    const [method, path, status] = f.key.slice("server::".length).split(" ");
    return {
      summary: `The server fails (HTTP ${status}) when a user uses "${name}" on ${route}, so the action never completes.`,
      steps,
      expected: `${method} ${path} is handled without a server error.`,
      actual:
        observed.filter((e) => e.startsWith("server failed")).join("; ") ||
        `${method} ${path} returned ${status}.`,
    };
  }

  if (f.key.startsWith("no-feedback::")) {
    return {
      summary: `"${name}" on ${route} does nothing visible, so the user cannot tell whether anything happened.`,
      steps,
      expected:
        subject.kind === "form"
          ? EXPECTATIONS.ActionFeedback
          : EXPECTATIONS.ActionEffect,
      actual: join(observed),
    };
  }

  const contract = f.results[0].result.contract;
  const summaries: Partial<Record<typeof contract, string>> = {
    StateConsistency: `After "${name}", parts of the page keep showing the old state until the user reloads.`,
    FormatValidation: `"${name}" on ${route} accepts input in an invalid format, so bad data is saved without warning.`,
    ConfirmBeforeDestructive: `"${name}" takes effect on a single click, with no confirmation and no undo, so one mis-click loses data.`,
    DeletionEffective: `"${name}" does not actually remove the record.`,
  };
  if (contract === "StateConsistency")
    steps.push(
      "Note the navigation right after the page changes",
      "Reload the page and compare",
    );
  if (contract === "DeletionEffective") steps.push("Open the same page again");

  const judged = f.results.find((r) => r.judgment)?.judgment;
  return {
    summary:
      summaries[contract] ??
      (judged
        ? judged.reason
        : `${EXPECTATIONS[contract]} This expectation is not met.`),
    steps,
    expected: EXPECTATIONS[contract],
    actual: join(observed),
  };
}

function formSteps(c: Candidate): string[] {
  const steps = c.session === "authenticated" ? [LOGIN_STEP] : [];
  steps.push(`Open ${c.route}`);
  for (const field of c.fields) {
    const step = fieldStep(field, c);
    if (step) steps.push(step);
  }
  const last = c.fields[c.fields.length - 1];
  steps.push(
    c.submitMode === "enter" || !c.submit
      ? `Press Enter in "${cleanText(last.label)}"`
      : `Click "${cleanText(c.submit.label)}"`,
  );
  return steps;
}

function fieldStep(field: FieldTarget, c: Candidate): string | undefined {
  if (field.disabled) return undefined;
  const label = `"${cleanText(field.label)}"`;
  if (c.strategy === "emptySubmit")
    return field.role === "checkbox"
      ? `Leave ${label} unticked`
      : `Leave ${label} empty`;
  if (field.role === "checkbox") return `Tick ${label}`;

  const kind = formatKind(field);
  if (c.strategy === "invalidFormat" && kind) {
    return `Enter an invalid ${kind} in ${label}, e.g. "${kind === "email" ? "not-an-email" : "not a url"}"`;
  }
  const password = field.inputType === "password";
  if (c.isCredentialForm)
    return `Enter the test account's ${password ? "password" : "email"} in ${label}`;
  if (password) return `Enter a password in ${label}`;
  if (kind) return `Enter a valid ${kind} in ${label}`;
  return `Enter any valid text in ${label}`;
}

function actionSteps(a: ClassifiedAction): string[] {
  const steps = a.control.session === "authenticated" ? [LOGIN_STEP] : [];
  if (a.routePattern.includes(":id")) {
    steps.push(
      `Open any ${a.routePattern} page (the scan used a record it created itself, never existing data)`,
    );
  } else {
    steps.push(`Open ${a.routePattern}`);
  }
  steps.push(`Click "${cleanText(a.control.label)}"`);
  return steps;
}

function describeHeuristic(f: Finding): Description {
  const observed = f.evidence.filter((e) => !NOTE.test(e));

  if (f.heuristic === "status-messages") {
    return {
      summary:
        "Error messages appear on screen, but screen readers do not announce them, so blind users are not told why a form failed.",
      steps: [
        "Open one of the forms listed in the evidence",
        "Submit it with missing or invalid input",
        "With a screen reader running (NVDA, VoiceOver), the error message is not read out",
      ],
      expected:
        'Error messages are announced to assistive technology (role="alert" or role="status").',
      actual: join(observed.slice(1, 4)),
    };
  }

  if (f.heuristic === "list-scaling") {
    const endpoint = f.key.split("::").pop() ?? "the list request";
    return {
      summary: `${endpoint} gets slower with every record, so pages that use it get slower as data grows.`,
      steps: [
        LOGIN_STEP,
        `Open ${f.route} and note how long ${endpoint} takes (browser DevTools → Network)`,
        "Add a few more records",
        `Open ${f.route} again: the request takes longer by roughly the same amount per record`,
      ],
      expected: "Response time stays roughly flat as the list grows.",
      actual: join(observed.slice(0, 2)),
    };
  }

  const help = f.title.replace(/\s*\([^)]*\)$/, "");
  const pages = f.evidence[0]?.match(/element\(s\) on (.+)$/)?.[1] ?? f.route;
  const impact: Record<string, string> = {
    "image-alt": "Screen reader users get no description of the image.",
    "color-contrast":
      "Some text is too faint to read for people with low vision or on a bright screen.",
    label: "Screen reader users cannot tell what a field is for.",
    "link-name": "Screen reader users cannot tell where a link goes.",
    "button-name": "Screen reader users cannot tell what a button does.",
  };
  return {
    summary: `${help}. ${impact[f.heuristic ?? ""] ?? "This makes the page harder to use with assistive technology."}`,
    steps: [
      `Open ${pages}`,
      "Run an accessibility checker such as axe DevTools, or inspect the elements listed in the evidence",
    ],
    expected: `${help} (${f.standard ?? "WCAG"}).`,
    actual: join(observed.slice(0, 2)),
  };
}

function join(lines: string[]): string {
  return lines.slice(0, 3).join("; ");
}
