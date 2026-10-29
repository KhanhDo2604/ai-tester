import { detectCandidates } from "../candidates/detectCandidates";
import { Candidate } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import { errorText } from "../driver/types";
import { confirmIfAsked } from "../discovery/executeAction";
import { ClassifiedAction } from "../discovery/types";
import {
  ExecutionContext,
  executeCandidate,
  Observation,
  valueFor,
} from "../execution/executeCandidate";
import { formatKind } from "../execution/fillValues";
import { authenticate, DiscoveredState } from "../explore/exploreStates";
import { routePattern } from "../explore/stateKey";
import { captureSignature } from "../state/signature";

export interface OwnAccount {
  username: string;
  password: string;
  registeredVia: string;
}

const USERNAME_LABEL = /user\s?name|login/i;

const identityField = (c: Candidate) =>
  c.fields.find((f) => formatKind(f) === "email") ??
  c.fields.find((f) => USERNAME_LABEL.test(f.label));
const passwordField = (c: Candidate) =>
  c.fields.find((f) => f.inputType === "password");

/** A sign-up form: a password field plus an email or username, and more than a login form's two fields. */
function isSignUpForm(c: Candidate): boolean {
  return (
    c.session === "anonymous" &&
    !c.isCredentialForm &&
    !!passwordField(c) &&
    !!identityField(c)
  );
}

/** The account a submitted sign-up form created, if the app accepted it (moved on to another page). */
export function accountFromSignUp(
  o: Observation,
  config: ScanConfig,
): OwnAccount | undefined {
  const c = o.candidate;
  if (
    !isSignUpForm(c) ||
    c.strategy === "emptySubmit" ||
    !o.runId ||
    !o.submitted ||
    o.error ||
    !o.after
  )
    return;
  if (routePattern(o.after.route) === routePattern(c.route)) return;
  const username = valueFor(identityField(c)!, c, config, o.runId);
  if (!username || username === config.credentials?.username) return;
  return {
    username,
    password: valueFor(passwordField(c)!, c, config, o.runId),
    registeredVia: `${c.route} "${c.formName}" (${c.strategy})`,
  };
}

/**
 * Registers an account through the app's own sign-up form, so a scan without
 * a test account can still reach the logged-in part of the app.
 */
export async function registerOwnAccount(
  ctx: ExecutionContext,
  states: DiscoveredState[],
): Promise<{ account?: OwnAccount; failure: string }> {
  const forms = states
    .flatMap((s) => detectCandidates(s.graph, "anonymous", s.path).candidates)
    .filter((c) => isSignUpForm(c) && c.strategy === "validSubmit");
  if (forms.length === 0) return { failure: "no sign-up form was found" };

  const failures: string[] = [];
  for (const form of forms) {
    const observation = await executeCandidate(ctx, form);
    const account = accountFromSignUp(observation, ctx.config);
    if (account) return { account, failure: "" };
    failures.push(
      `${form.route}: ${observation.error ?? "still on the sign-up page after submitting"}`,
    );
  }
  return { failure: failures.join("; ") };
}

/**
 * Deletes an account the tester created, with the app's own control: logs in
 * with it, clicks the control, then proves it by trying to log in again.
 * Only ever called with credentials the tester generated itself.
 */
export async function removeOwnAccount(
  ctx: ExecutionContext,
  account: OwnAccount,
  actions: ClassifiedAction[],
  anonymousStates: DiscoveredState[],
): Promise<{ removed: boolean; note: string }> {
  const control = actions.find(
    (a) =>
      a.contract?.deletesCurrentAccount &&
      a.control.session === "authenticated",
  );
  if (!control)
    return {
      removed: false,
      note: "the app has no way to delete an account from its UI",
    };

  const accountConfig: ScanConfig = {
    ...ctx.config,
    credentials: { username: account.username, password: account.password },
  };
  const login = await authenticate(ctx.driver, accountConfig, anonymousStates);
  if (!login.result)
    return {
      removed: false,
      note: "could not log in with it, so it could not be deleted",
    };

  const session = await ctx.driver.newSession(login.result.storage);
  const label = control.control.label;
  try {
    await session.restore(control.control.path);
    const before = await captureSignature(session);
    await session.click(control.control);
    await session.settle();
    await confirmIfAsked(session, label, before.dialogs, session.takeDialogs());
  } catch (err) {
    return { removed: false, note: `"${label}" failed: ${errorText(err)}` };
  } finally {
    await session.close();
  }

  const again = await authenticate(ctx.driver, accountConfig, anonymousStates);
  return again.result
    ? {
        removed: false,
        note: `"${label}" was clicked, but the account can still log in`,
      }
    : {
        removed: true,
        note: `deleted with "${label}"; logging in with it now fails`,
      };
}
