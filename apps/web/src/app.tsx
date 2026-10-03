import { useEffect, useState } from "react";
import { ReportView } from "./ReportView";
import { ScanForm } from "./ScanForm";
import { ScanProgress } from "./ScanProgress";

export function navigate(hash: string): void {
  window.location.hash = hash;
}

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

export function App() {
  const [, view, id] = useHash().split("/");

  return (
    <>
      <header className="topbar">
        <a href="#/" className="brand">
          AI App Tester
        </a>
      </header>
      <main className="page">
        {view === "scan" && id ? (
          <ScanProgress id={id} />
        ) : view === "report" && id ? (
          <ReportView id={id} />
        ) : (
          <ScanForm />
        )}
      </main>
    </>
  );
}
