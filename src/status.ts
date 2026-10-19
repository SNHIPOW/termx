// Agent status tracking per tmux session, with SSE broadcast.
// Latest status per session, persisted to disk so a server restart doesn't
// wipe every session's state (restarts reset all dots to idle and invalidated
// the clients' read-markers, which looked like every agent refreshing at once).
import { readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const STATUSES = ["running", "waiting", "done", "error", "idle"] as const;
export type Status = (typeof STATUSES)[number];

export interface SessionStatus {
  status: Status;
  message: string;
  updatedAt: number;
}

const STATUS_FILE = join(homedir(), ".termx-status.json");
const store = new Map<string, SessionStatus>();
const subscribers = new Set<(payload: string) => void>();

export function isStatus(v: unknown): v is Status {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

// Restore on startup. updatedAt is kept as-is so clients' "already viewed"
// bookkeeping (keyed by updatedAt) stays valid across restarts.
try {
  const saved = JSON.parse(readFileSync(STATUS_FILE, "utf8"));
  for (const [name, info] of Object.entries(saved ?? {})) {
    const s = info as SessionStatus;
    if (s && isStatus(s.status) && typeof s.updatedAt === "number") {
      store.set(name, { status: s.status, message: s.message ?? "", updatedAt: s.updatedAt });
    }
  }
} catch {}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function flush(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    // Write-then-rename so a crash mid-write can't leave a truncated file.
    const tmp = STATUS_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(store)));
    renameSync(tmp, STATUS_FILE);
  } catch {}
}
function scheduleSave(): void {
  if (!saveTimer) saveTimer = setTimeout(flush, 500);
}
// The watchdog stops the server with SIGTERM; don't lose the last 500ms.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => { flush(); process.exit(0); });
}

export function setStatus(session: string, status: Status, message = ""): void {
  // Idempotent for repeated same-status reports: reuse the existing updatedAt
  // so the client's "already viewed" bookkeeping (readDone[name] === updatedAt)
  // isn't invalidated by e.g. a follow-up idle_prompt Notification that repeats
  // the 'done' state. Only a real transition to a new status bumps the timestamp.
  const prev = store.get(session);
  const updatedAt = prev && prev.status === status ? prev.updatedAt : Date.now();
  const info: SessionStatus = { status, message, updatedAt };
  store.set(session, info);
  scheduleSave();
  broadcast({ session, ...info });
}

export function getStatus(session: string): SessionStatus | undefined {
  return store.get(session);
}

export function getAllStatus(): Record<string, SessionStatus> {
  return Object.fromEntries(store);
}

export function clearStatus(session: string): void {
  if (store.delete(session)) {
    scheduleSave();
    // Notify clients that this session is gone / reset to idle.
    broadcast({ session, status: "idle", message: "", updatedAt: Date.now() });
  }
}

// Move a session's status to a new name (called on rename) so the store doesn't
// keep a stale key and the renamed session keeps its live status.
export function renameStatus(oldName: string, newName: string): void {
  const info = store.get(oldName);
  store.delete(oldName);
  scheduleSave();
  // Tell clients the old key is gone.
  broadcast({ session: oldName, status: "idle", message: "", updatedAt: Date.now() });
  if (info) {
    store.set(newName, info);
    broadcast({ session: newName, ...info });
  }
}

// --- SSE ---

export function subscribe(fn: (payload: string) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function broadcast(data: object): void {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const fn of subscribers) {
    try {
      fn(payload);
    } catch {
      // Drop broken subscribers silently; they clean up on stream cancel.
    }
  }
}
