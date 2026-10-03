import { useCallback, useEffect, useState } from "react";
import { api, type Report, type ReportItem } from "./api";
import { FindingItem } from "./findingItem";

type Tab = "bugs" | "improvements" | "suppressed" | "notChecked";

export function ReportView({ id }: { id: string }) {
  const [report, setReport] = useState<Report>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>("bugs");

  const load = useCallback(() => {
    api
      .scan(id)
      .then((s) =>
        s.report
          ? setReport(s.report)
          : setError("This scan has no report yet."),
      )
      .catch((err) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, [id]);

  useEffect(load, [load]);

  if (error)
    return (
      <p role="alert" className="error card">
        {error}
      </p>
    );
  if (!report) return <p className="card">Loading report…</p>;

  const { summary: s, coverage: c } = report;
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: "bugs", label: "Bugs", count: report.bugs.length },
    {
      id: "improvements",
      label: "Improvements",
      count: report.improvements.length,
    },
    {
      id: "suppressed",
      label: "Marked not a problem",
      count: report.suppressed.length,
    },
    {
      id: "notChecked",
      label: "Not checked",
      count: report.notChecked.length + report.discarded.length,
    },
  ];
  const items: ReportItem[] =
    tab === "bugs"
      ? report.bugs
      : tab === "improvements"
        ? report.improvements
        : report.suppressed;

  return (
    <>
      <section className="card">
        <div className="report-head">
          <div>
            <h1>Report for {report.target}</h1>
            <p className="muted">
              {new Date(report.finishedAt).toLocaleString()} · model{" "}
              {report.llm}
            </p>
          </div>
          <a href="#/" className="button">
            New scan
          </a>
        </div>

        {(report.warnings ?? []).length > 0 && (
          <div className="warning" role="status">
            <strong>This report may be incomplete.</strong>
            <ul>
              {report.warnings!.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="stats">
          <Stat value={s.confirmedBugs} label="Confirmed bugs" tone="bad" />
          <Stat
            value={s.potentialIssues}
            label="Potential issues"
            tone="warn"
          />
          <Stat value={s.improvements} label="Improvements" tone="info" />
          <Stat value={s.suppressed} label="Marked not a problem" tone="off" />
        </div>

        <p className="coverage">
          Tested {c.pages.length} pages, {c.formInteractions} form interactions
          and {c.actions} buttons; re-ran {c.reruns} findings to confirm them.{" "}
          {c.llmCalls} model calls ({c.llmCacheHits} answered from cache). Took{" "}
          {Math.round(c.durationMs / 1000)}s,{" "}
          {Math.round(c.networkWaitMs / 1000)}s of it waiting for the app.
        </p>
      </section>

      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label} <span className="count">{t.count}</span>
          </button>
        ))}
      </div>

      <section className="card" role="tabpanel">
        {tab === "notChecked" ? (
          <NotChecked report={report} />
        ) : items.length === 0 ? (
          <p className="muted">Nothing here.</p>
        ) : (
          <ul className="findings">
            {items.map((item) => (
              <FindingItem
                key={item.id}
                item={item}
                target={report.target}
                onChange={load}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function Stat({
  value,
  label,
  tone,
}: {
  value: number;
  label: string;
  tone: string;
}) {
  return (
    <div className={`stat tone-${tone}`}>
      <span className="stat-value">{value}</span>
      <span>{label}</span>
    </div>
  );
}

function NotChecked({ report }: { report: Report }) {
  return (
    <>
      <p className="muted">
        What the tester deliberately did not do, and why. Nothing here was
        hidden from the results.
      </p>
      {report.notChecked.length > 0 && (
        <ul className="plain">
          {report.notChecked.map((n, i) => (
            <li key={i}>
              <strong>{n.subject}</strong>: {n.reason}
            </li>
          ))}
        </ul>
      )}
      {report.discarded.length > 0 && (
        <>
          <h3>Dropped because they did not happen again on a second run</h3>
          <ul className="plain">
            {report.discarded.map((d) => (
              <li key={d.id}>
                <strong>{d.title}</strong>: {d.whyLevel}
              </li>
            ))}
          </ul>
        </>
      )}
      {report.cleanup.length > 0 && (
        <>
          <h3>Records the tester created and cleaned up</h3>
          <ul className="plain">
            {report.cleanup.map((c, i) => (
              <li key={i}>
                {c.path}: {c.removed ? "removed" : `kept (${c.note})`}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}
