import { useState } from "react";
import {
  api,
  REASON_LABELS,
  type ReportItem,
  type SuppressionReason,
} from "./api";

const SOURCE_LABELS: Record<ReportItem["source"], string> = {
  predefined: "built-in rule",
  discovered: "AI hypothesis, behaviour observed",
  judged: "AI judgment of an ambiguous outcome",
  heuristic: "heuristic check",
};

const sentence = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function FindingItem({
  item,
  target,
  onChange,
}: {
  item: ReportItem;
  target: string;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [marking, setMarking] = useState(false);
  const [reason, setReason] = useState<SuppressionReason>("false-positive");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string>();

  async function copy() {
    await navigator.clipboard.writeText(item.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function run(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
      setMarking(false);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <li className="finding">
      <button
        className="finding-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span
          className={`badge level-${item.suppression ? "off" : item.level}`}
        >
          {item.levelLabel}
        </span>
        <span className="finding-title">{item.title}</span>
        <span className="muted route">{item.route}</span>
      </button>

      {open && (
        <div className="finding-body">
          <p className="summary">{item.summary}</p>

          <h3>Steps to reproduce</h3>
          <ol>
            {item.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>

          <div className="row">
            <div>
              <h3>Expected</h3>
              <p>{sentence(item.expected)}</p>
            </div>
            <div>
              <h3>Actual</h3>
              <p>{sentence(item.actual)}</p>
            </div>
          </div>

          <h3>Why we believe this</h3>
          <p>
            {sentence(item.whyLevel)}.
            {item.aiConfidence !== undefined &&
              ` Model confidence ${Math.round(item.aiConfidence * 100)}% (context only, not used for the level).`}
          </p>
          <p className="standard">Source: {SOURCE_LABELS[item.source]}</p>
          {item.standard && (
            <p className="standard">Standard: {item.standard}</p>
          )}

          <details>
            <summary>Technical evidence</summary>
            <ul className="evidence">
              {item.evidence.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </details>

          {item.suppression && (
            <p className="hint">
              Marked as {REASON_LABELS[item.suppression.reason].toLowerCase()}
              {item.suppression.note && `: "${item.suppression.note}"`} on{" "}
              {new Date(item.suppression.at).toLocaleString()}.
            </p>
          )}

          <div className="actions">
            <button onClick={copy}>
              {copied ? "Copied" : "Copy as GitHub issue"}
            </button>
            {item.suppression ? (
              <button
                onClick={() => run(() => api.unsuppress(target, item.key))}
              >
                Restore
              </button>
            ) : (
              !marking && (
                <button onClick={() => setMarking(true)}>
                  Mark as not a problem
                </button>
              )
            )}
          </div>

          {marking && (
            <div className="mark">
              <label>
                Reason
                <select
                  value={reason}
                  onChange={(e) =>
                    setReason(e.target.value as SuppressionReason)
                  }
                >
                  {Object.entries(REASON_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Note (optional)
                <input value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <p className="hint">
                Hidden from future scans of {target}. You can restore it at any
                time.
              </p>
              <div className="actions">
                <button
                  className="primary"
                  onClick={() =>
                    run(() => api.suppress(target, item.key, reason, note))
                  }
                >
                  Confirm
                </button>
                <button onClick={() => setMarking(false)}>Cancel</button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
        </div>
      )}
    </li>
  );
}
