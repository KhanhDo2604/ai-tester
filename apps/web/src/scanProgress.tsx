import { useEffect, useState } from "react";
import { api } from "./api";
import { navigate } from "./app";

const STAGE_HINTS: [RegExp, string][] = [
  [
    /^Crawling/,
    "Following links to find every page, and logging in with the test account.",
  ],
  [
    /^Running \d+ form/,
    "Submitting every form three ways: empty, filled in correctly, and with badly formatted input.",
  ],
  [
    /^Classifying/,
    "Asking the local model what each button does, then trying it on a record the tester created itself.",
  ],
  [
    /^Judging/,
    "Asking the model only about outcomes the rules could not decide on their own.",
  ],
  [
    /^Reproducing/,
    "Running every problem a second time. Anything that does not happen again is dropped.",
  ],
  [
    /^Running UX/,
    "Checking accessibility against WCAG, screen-reader messages, and how list pages scale.",
  ],
  [
    /^Cleaning/,
    "Deleting the records the tester created, so the app is left as it was.",
  ],
];

interface Stage {
  message: string;
  at: number;
}

export function ScanProgress({ id }: { id: string }) {
  const [stages, setStages] = useState<Stage[]>([]);
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(Date.now());
  const [startedAt] = useState(Date.now());

  useEffect(() => {
    const source = new EventSource(api.eventsUrl(id));
    source.addEventListener("progress", (e) => {
      const { message, at } = JSON.parse((e as MessageEvent).data);
      setStages((prev) =>
        prev.some((s) => s.message === message)
          ? prev
          : [...prev, { message, at: Date.parse(at) }],
      );
    });
    source.addEventListener("done", () => {
      source.close();
      navigate(`#/report/${id}`);
    });
    source.addEventListener("failed", (e) => {
      source.close();
      setError(
        JSON.parse((e as MessageEvent).data).error ?? "The scan failed.",
      );
    });
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      source.close();
      clearInterval(timer);
    };
  }, [id]);

  const seconds = Math.round((now - (stages[0]?.at ?? startedAt)) / 1000);

  return (
    <section className="card">
      <h1>Scanning…</h1>
      <p className="muted">
        Elapsed: {Math.floor(seconds / 60)}m {seconds % 60}s. A scan usually
        takes a few minutes, mostly waiting for the app to respond.
      </p>
      {error ? (
        <>
          <p role="alert" className="error">
            {error}
          </p>
          <a href="#/">Back</a>
        </>
      ) : (
        <ol className="stages" aria-live="polite">
          {stages.map((s, i) => {
            const current = i === stages.length - 1;
            const hint = STAGE_HINTS.find(([pattern]) =>
              pattern.test(s.message),
            )?.[1];
            return (
              <li key={s.message} className={current ? "current" : "done"}>
                <span className="stage-mark" aria-hidden="true">
                  {current ? "…" : "✓"}
                </span>
                <div>
                  <strong>{s.message}</strong>
                  {hint && <p className="hint">{hint}</p>}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
