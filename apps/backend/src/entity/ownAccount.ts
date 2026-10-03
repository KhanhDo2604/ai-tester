import { Browser, Page } from "playwright";
import { detectCandidates } from "../candidates/detectCandidates";
import { Candidate } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import {
  authenticate,
  DiscoveredPage,
  routePattern,
} from "../crawl/discoverPages";
import { confirmIfAsked } from "../discovery/executeAction";
import { ClassifiedAction } from "../discovery/types";
import {
  executeCandidate,
  navigate,
  Observation,
  openPage,
  valueFor,
} from "../execution/executeCandidate";
import { formatKind } from "../execution/fillValues";
import { captureSignature } from "../state/signature";

type AriaRole = Parameters<Page["getByRole"]>[0];

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
  browser: Browser,
  config: ScanConfig,
  pages: DiscoveredPage[],
): Promise<{ account?: OwnAccount; failure: string }> {
  const forms = pages
    .flatMap((p) => detectCandidates(p.graph, "anonymous").candidates)
    .filter((c) => isSignUpForm(c) && c.strategy === "validSubmit");
  if (forms.length === 0) return { failure: "no sign-up form was found" };

  const failures: string[] = [];
  for (const form of forms) {
    const observation = await executeCandidate(browser, config, form);
    const account = accountFromSignUp(observation, config);
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
  browser: Browser,
  config: ScanConfig,
  account: OwnAccount,
  actions: ClassifiedAction[],
  anonymousPages: DiscoveredPage[],
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
    ...config,
    credentials: { username: account.username, password: account.password },
  };
  const login = await authenticate(browser, accountConfig, anonymousPages);
  if (!login.result)
    return {
      removed: false,
      note: "could not log in with it, so it could not be deleted",
    };

  const { context, page, network } = await openPage(
    browser,
    config,
    login.result.storageState,
  );
  const nativeDialogs: string[] = [];
  page.on("dialog", async (d) => {
    nativeDialogs.push(d.message());
    await d.accept().catch(() => {});
  });

  const label = control.control.label;
  try {
    await navigate(page, control.control.route);
    const before = await captureSignature(page, network);
    await page
      .getByRole(control.control.role as AriaRole, { name: label, exact: true })
      .first()
      .click();
    await network.settle();
    await confirmIfAsked(page, network, label, before.dialogs, nativeDialogs);
  } catch (err) {
    return {
      removed: false,
      note: `"${label}" failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
    };
  } finally {
    await context.close();
  }

  const again = await authenticate(browser, accountConfig, anonymousPages);
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
