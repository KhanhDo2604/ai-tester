import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { Suppression, SuppressionReason } from "./types";

type Store = Record<string, Record<string, Suppression>>;

const FILE = join(process.cwd(), ".ai-tester-data", "suppressions.json");

function load(): Store {
  return existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
}

function save(store: Store): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(store, null, 2));
}

/** Suppressions are per target app: the same finding key on another app is a different finding. */
export function suppressionsFor(target: string): Record<string, Suppression> {
  return load()[target] ?? {};
}

export function suppress(
  target: string,
  key: string,
  reason: SuppressionReason,
  note?: string,
): Suppression {
  const store = load();
  const suppression: Suppression = {
    reason,
    note: note?.trim() || undefined,
    at: new Date().toISOString(),
  };
  store[target] = { ...(store[target] ?? {}), [key]: suppression };
  save(store);
  return suppression;
}

export function unsuppress(target: string, key: string): void {
  const store = load();
  if (!store[target]?.[key]) return;
  delete store[target][key];
  save(store);
}
