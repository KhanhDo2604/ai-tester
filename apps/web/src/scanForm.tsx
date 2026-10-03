import { FormEvent, useEffect, useState } from "react";
import { api, type HistoryEntry } from "./api";
import { navigate } from "./app";

export function ScanForm() {
  const [baseUrl, setBaseUrl] = useState("http://localhost:5173");
  const [startPath, setStartPath] = useState("/");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  useEffect(() => {
    api
      .history()
      .then(setHistory)
      .catch(() => setHistory([]));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const { id } = await api.startScan({
        baseUrl,
        startPath,
        username: username || undefined,
        password: password || undefined,
      });
      navigate(`#/scan/${id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card">
        <h1>Scan an app</h1>
        <p className="muted">
          The tester opens the app in a browser, uses every form and button it
          can find, and reports what is broken and what could be better. No test
          cases needed.
        </p>
        <form onSubmit={submit} className="form">
          <label>
            App URL
            <input
              type="url"
              required
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </label>
          <label>
            Start page
            <input
              value={startPath}
              onChange={(e) => setStartPath(e.target.value)}
              placeholder="/"
            />
          </label>
          <fieldset>
            <legend>Test account (optional)</legend>
            <p className="hint">
              Used only to log in during this scan, so pages behind the login
              are tested too. Never saved.
            </p>
            <div className="row">
              <label>
                Email or username
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="off"
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                />
              </label>
            </div>
          </fieldset>
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Starting…" : "Start scan"}
          </button>
        </form>
      </section>

      {history.length > 0 && (
        <section className="card">
          <h2>Previous scans</h2>
          <ul className="history">
            {history.map((h) => (
              <li key={h.id}>
                <a href={`#/report/${h.id}`}>{h.target}</a>
                <span className="muted">
                  {new Date(h.finishedAt).toLocaleString()}
                </span>
                <span>
                  {h.summary.confirmedBugs + h.summary.potentialIssues} bugs ·{" "}
                  {h.summary.improvements} improvements
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
