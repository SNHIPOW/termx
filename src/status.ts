// Agent status tracking per tmux session, with SSE broadcast.
// In-memory only (latest status per session, no history / no persistence).

export const STATUSES = ["running", "waiting", "done", "error", "idle"] as const;
export type Status = (typeof STATUSES)[number];

export interface SessionStatus {
  status: Status;
  message: string;
  updatedAt: number;
}

const store = new Map<string, SessionStatus>();
const subscribers = new Set<(payload: string) => void>();

export function isStatus(v: unknown): v is Status {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
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
    // Notify clients that this session is gone / reset to idle.
    broadcast({ session, status: "idle", message: "", updatedAt: Date.now() });
  }
}

// Move a session's status to a new name (called on rename) so the store doesn't
// keep a stale key and the renamed session keeps its live status.
export function renameStatus(oldName: string, newName: string): void {
  const info = store.get(oldName);
  store.delete(oldName);
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
