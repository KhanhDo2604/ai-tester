import { FieldTarget } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";

const GENERATED_PASSWORD = "Tester!2345abc";

/** A short id that makes generated values unique per execution (e.g. sign-up emails). */
export function newRunId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export type FormatKind = "email" | "url";

/**
 * Fields whose value has a well-defined format, recognised from the input
 * type first and the label second. These are the fields the invalidFormat
 * strategy fills with malformed values.
 *
 * Number and date fields are deliberately left out: browsers refuse to
 * even type letters into them, so a malformed value can't be entered the
 * way a user would.
 */
export function formatKind(field: FieldTarget): FormatKind | undefined {
  const label = field.label.toLowerCase();
  const type = field.inputType?.toLowerCase();
  if (type === "email" || /e-?mail/.test(label)) return "email";
  if (type === "url" || /website|url/.test(label)) return "url";
  return undefined;
}

/** A value a real user could plausibly type by mistake, and that no valid input of that kind matches. */
export function malformedValue(kind: FormatKind, runId: string): string {
  return kind === "email" ? `not-an-email-${runId}` : `not a url ${runId}`;
}

/**
 * Picks a plausible value for a text field from its input type first and
 * its label second. Label matching is English-only keyword matching — a
 * known limitation, acceptable because a wrong guess only produces a
 * rejected submission, which Action Feedback still treats as valid
 * feedback (the app told the user something).
 */
export function valueForField(
  field: FieldTarget,
  isCredentialForm: boolean,
  config: ScanConfig,
  runId: string,
): string {
  const label = field.label.toLowerCase();
  const type = field.inputType?.toLowerCase();
  const useCredentials = isCredentialForm && config.credentials !== undefined;

  if (type === "password") {
    return useCredentials ? config.credentials!.password : GENERATED_PASSWORD;
  }
  // In a credential form, the only other text field is the username/email.
  if (useCredentials) return config.credentials!.username;

  const kind = formatKind(field);
  if (kind === "email") return `ai-tester+${runId}@example.test`;
  if (kind === "url") return "https://example.com";
  if (type === "number" || field.role === "spinbutton") return "1";
  if (type === "tel" || /phone|mobile/.test(label)) return "0211234567";
  if (type === "date") return "2030-01-15";
  if (/user\s?name|login/.test(label)) return `aitester_${runId}`;
  if (/name/.test(label)) return "Alex Tester";
  return `AI Tester sample ${runId}`;
}
