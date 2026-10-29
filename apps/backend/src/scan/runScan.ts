import { detectCandidates } from "../candidates/detectCandidates";
import { Candidate, DeferredControl } from "../candidates/types";
import { ScanConfig } from "../config/scanConfig";
import { checkActionContracts } from "../contracts/actionContracts";
import { checkContracts } from "../contracts/checkContracts";
import { buildActionTargets } from "../discovery/actionTargets";
import { classifyControl } from "../discovery/classifyControl";
import { ClassifiedAction } from "../discovery/types";
import { ActionObservation, executeAction } from "../discovery/executeAction";
import { cleanUpOwnRecords, CleanupResult } from "../entity/cleanup";
import {
  accountFromSignUp,
  OwnAccount,
  registerOwnAccount,
  removeOwnAccount,
} from "../entity/ownAccount";
import { createDriver } from "../driver/createDriver";
import { locationOf } from "../driver/types";
import {
  ExecutionContext,
  executeCandidate,
  Observation,
} from "../execution/executeCandidate";
import {
  authenticate,
  DiscoveredState,
  ExploreResult,
  exploreStates,
  navigationId,
} from "../explore/exploreStates";
import { routePattern } from "../explore/stateKey";
import { assignLevel } from "../findings/evidenceLadder";
import { groupFindings } from "../findings/group";
import { isExecutionFailure, judge } from "../findings/judge";
import { reproduce, RunContext } from "../findings/reproduce";
import { CheckedResult, Finding, subjectId } from "../findings/types";
import { auditAccessibility } from "../heuristics/accessibility";
import { checkListScaling } from "../heuristics/listScaling";
import { checkStatusMessages } from "../heuristics/statusMessages";
import { LlmClient } from "../llm/types";

export interface NotChecked {
  subject: string;
  reason: string;
}

export interface ScanStats {
  pages: string[];
  formCandidates: number;
  actions: number;
  reruns: number;
  llmCalls: number;
  llmCacheHits: number;
  durationMs: number;
  networkWaitMs: number;
}

export interface ScanReport {
  baseUrl: string;
  llm: string;
  findings: Finding[];
  discarded: Finding[];
  notChecked: NotChecked[];
  cleanup: CleanupResult[];
  stats: ScanStats;
}

/** Subject of the notChecked entry written when the logged-in part of the app could not be reached. */
export const LOGGED_IN_AREA = "logged-in pages";

export interface ScanOptions {
  onProgress?: (message: string) => void;
}

/** The whole pipeline: explore → detect → execute → contracts → judge → group → reproduce → heuristics → Evidence Ladder. */
export async function runScan(
  config: ScanConfig,
  llm: LlmClient | undefined,
  options: ScanOptions = {},
): Promise<ScanReport> {
  const log = options.onProgress ?? (() => {});
  const startedAt = Date.now();
  const driver = await createDriver(config);

  try {
    log("Exploring");
    const anonymous = await exploreStates(driver, config, "anonymous");
    const notChecked: NotChecked[] = [];
    const inMemoryStates = new Set(anonymous.inMemoryStates);
    const navigation = new Set(anonymous.navigation);
    const noteFailures = (explored: ExploreResult) => {
      for (const f of explored.failures)
        notChecked.push({
          subject: `${f.session} state ${f.location}`,
          reason: f.error,
        });
      explored.inMemoryStates.forEach((k) => inMemoryStates.add(k));
      explored.navigation.forEach((n) => navigation.add(n));
    };
    noteFailures(anonymous);
    const baseCtx: ExecutionContext = { driver, config, inMemoryStates };

    // Without a test account, sign up with a throwaway one and delete it at the end.
    let ownAccount: OwnAccount | undefined;
    if (!config.credentials) {
      log("Registering a test account");
      const registration = await registerOwnAccount(baseCtx, anonymous.states);
      ownAccount = registration.account;
      if (!ownAccount && registration.failure !== "no sign-up form was found") {
        notChecked.push({
          subject: LOGGED_IN_AREA,
          reason: `no test account was given and signing up failed: ${registration.failure}`,
        });
      }
    }
    const scanConfig: ScanConfig = ownAccount
      ? {
          ...config,
          credentials: {
            username: ownAccount.username,
            password: ownAccount.password,
          },
        }
      : config;

    const execCtx: ExecutionContext = { ...baseCtx, config: scanConfig };
    const authOutcome = await authenticate(
      driver,
      scanConfig,
      anonymous.states,
    );
    const auth = authOutcome.result;
    if (!auth && scanConfig.credentials) {
      notChecked.push({
        subject: LOGGED_IN_AREA,
        reason: `logging in failed: ${authOutcome.failures.join("; ")}`,
      });
    }
    const entries = auth ? [auth.landedOn, config.startPath ?? "/"] : [];
    let authenticated = auth
      ? await exploreStates(
          driver,
          scanConfig,
          "authenticated",
          auth.storage,
          entries,
        )
      : undefined;
    if (authenticated) noteFailures(authenticated);
    let states = [...anonymous.states, ...(authenticated?.states ?? [])];
    const { candidates, deferred } = collect(states, navigation);
    const ctx: RunContext = { ...execCtx, candidates, storage: auth?.storage };

    const checked: CheckedResult[] = [];
    const actionObservations: ActionObservation[] = [];
    const classified: ClassifiedAction[] = [];
    const formObservations: Observation[] = [];

    const runCandidates = async (list: Candidate[]) => {
      for (const candidate of list) {
        const storage =
          candidate.session === "authenticated" ? auth?.storage : undefined;
        const observation = await executeCandidate(ctx, candidate, storage);
        formObservations.push(observation);
        for (const result of checkContracts(observation))
          checked.push({ result, subject: { kind: "form", candidate } });
      }
    };
    log(`Running ${candidates.length} form interactions`);
    await runCandidates([...candidates]);

    // A new account starts empty; the records the form tests just created expose its record pages.
    if (ownAccount && auth) {
      log("Exploring again with the records the tests created");
      const known = new Set(states.map(stateIdentity));
      authenticated = await exploreStates(
        driver,
        scanConfig,
        "authenticated",
        auth.storage,
        entries,
      );
      authenticated.inMemoryStates.forEach((k) => inMemoryStates.add(k));
      authenticated.navigation.forEach((n) => navigation.add(n));
      states = [...anonymous.states, ...authenticated.states];
      const added = collect(
        authenticated.states.filter((s) => !known.has(stateIdentity(s))),
        navigation,
      );
      const fresh = added.candidates.filter(
        (c) => !candidates.some((known) => known.id === c.id),
      );
      candidates.push(...fresh);
      deferred.push(...added.deferred);
      log(`Running ${fresh.length} more form interactions`);
      await runCandidates(fresh);
    }

    const targets = buildActionTargets(deferred);
    log(`Classifying and running ${targets.length} standalone actions`);
    for (const target of targets) {
      const action = await classifyControl(llm, target);
      classified.push(action);
      const storage =
        target.control.session === "authenticated" ? auth?.storage : undefined;
      const observation = await executeAction(ctx, action, candidates, storage);
      actionObservations.push(observation);
      for (const result of checkActionContracts(observation))
        checked.push({ result, subject: { kind: "action", action } });
    }

    log("Judging ambiguous outcomes");
    for (const c of checked) {
      if (c.result.verdict === "NOT_APPLICABLE") {
        if (c.subject.kind === "action")
          notChecked.push({
            subject: subjectId(c.subject),
            reason: c.result.evidence[0],
          });
        continue;
      }
      if (c.result.verdict !== "AMBIGUOUS") continue;
      if (isExecutionFailure(c.result)) {
        notChecked.push({
          subject: `${subjectId(c.subject)} [${c.result.contract}]`,
          reason: c.result.evidence[0],
        });
        continue;
      }
      c.judgment = await judge(llm, c);
      if (!c.judgment)
        notChecked.push({
          subject: `${subjectId(c.subject)} [${c.result.contract}]`,
          reason: "ambiguous, and no model judgment was available",
        });
    }

    const findings = groupFindings(checked);
    log(`Reproducing ${findings.length} findings`);
    for (const finding of findings) {
      const rerun = await reproduce(ctx, finding);
      finding.reproduced = rerun.reproduced;
      finding.evidence.push(rerun.note);
      if (rerun.actionObservation)
        actionObservations.push(rerun.actionObservation);
      if (rerun.formObservation) formObservations.push(rerun.formObservation);
      assignLevel(finding);
    }

    log("Running UX heuristics");
    const scaling = await checkListScaling(ctx, states);
    scaling.notes.forEach((reason) =>
      notChecked.push({ subject: "list scaling", reason }),
    );
    const accessibility = await auditAccessibility(ctx, states);
    accessibility.notes.forEach((reason) =>
      notChecked.push({ subject: "accessibility", reason }),
    );
    const heuristicFindings = [
      ...accessibility.findings,
      ...checkStatusMessages(checked),
      ...scaling.findings,
    ];
    heuristicFindings.forEach(assignLevel);
    findings.push(...heuristicFindings);

    log("Cleaning up own records");
    const cleanup = await cleanUpOwnRecords(
      ctx,
      actionObservations,
      auth?.storage,
      scaling.created,
    );
    // The scan's own account plus every account its sign-up tests created.
    const accounts = new Map<string, OwnAccount>();
    for (const account of [
      ownAccount,
      ...formObservations.map((o) => accountFromSignUp(o, scanConfig)),
    ]) {
      if (account && !accounts.has(account.username))
        accounts.set(account.username, account);
    }
    if (accounts.size)
      log(`Deleting ${accounts.size} account(s) the tester created`);
    for (const account of accounts.values()) {
      const deletion = await removeOwnAccount(
        ctx,
        account,
        classified,
        anonymous.states,
      );
      cleanup.push({
        instance: {
          path: `account ${account.username}`,
          marker: "",
          createdBy: account.registeredVia,
        },
        removed: deletion.removed,
        note: deletion.note,
      });
    }

    const byLevel = (a: Finding, b: Finding) =>
      b.level - a.level || a.title.localeCompare(b.title);
    const stats = llm?.stats();
    return {
      baseUrl: config.baseUrl,
      llm: llm?.name ?? "none",
      findings: findings.filter((f) => f.level > 0).sort(byLevel),
      discarded: findings.filter((f) => f.level === 0),
      notChecked,
      cleanup,
      stats: {
        pages: states.map((s) => locationOf(s.path)),
        formCandidates: candidates.length,
        actions: targets.length,
        reruns: findings.length - heuristicFindings.length,
        llmCalls: stats?.calls ?? 0,
        llmCacheHits: stats?.cacheHits ?? 0,
        durationMs: Date.now() - startedAt,
        networkWaitMs: driver.idleWaitMs(),
      },
    };
  } finally {
    await driver.close();
  }
}

/** Addressable states are one per route pattern; others are told apart by their key. */
function stateIdentity(s: DiscoveredState): string {
  return s.path.steps.length ? s.key : routePattern(s.graph.route);
}

/** Candidates and standalone controls of every state. Controls already used as navigation need no classification. */
function collect(
  states: DiscoveredState[],
  navigation: Set<string>,
): { candidates: Candidate[]; deferred: DeferredControl[] } {
  const candidates: Candidate[] = [];
  const deferred: DeferredControl[] = [];
  const seen = new Set<string>();
  for (const state of states) {
    const detected = detectCandidates(state.graph, state.session, state.path);
    for (const c of detected.candidates) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      candidates.push(c);
    }
    deferred.push(
      ...detected.deferred.filter((d) => !navigation.has(navigationId(d))),
    );
  }
  return { candidates, deferred };
}
