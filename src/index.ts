#!/usr/bin/env bun
import { join } from "path";
import { homedir } from "os";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { cors } from "hono/cors";
import { parseArgs } from "util";
import { spawn } from "bun";
import { sendCommand, type PtyHandle } from "./pty";
import {
  setStatus,
  getStatus,
  getAllStatus,
  clearStatus,
  renameStatus,
  subscribe,
  isStatus,
  broadcast,
} from "./status";

const tmuxCheck = spawn(["which", "tmux"]);
if ((await tmuxCheck.exited) !== 0) {
  console.error("Error: tmux is not installed. Install it with: brew install tmux (macOS) or apt install tmux (Linux)");
  process.exit(1);
}

const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const { values } = parseArgs({
  args: Bun.argv,
  options: {
    port: { type: "string", short: "p" },
    theme: { type: "string", short: "t" },
  },
  strict: false,
  allowPositionals: true,
});

const DEFAULT_THEME = (values.theme as string) || "Dark";

// New tmux sessions start in the user's home directory by default.
// Override with TERMX_CWD if you want a different starting path.
const SESSION_CWD = process.env.TERMX_CWD || homedir() || process.cwd();
const parsedPort = parseInt((values.port as string) || process.env.PORT || "7681", 10);
const PORT = Number.isNaN(parsedPort) ? 7681 : parsedPort;

const app = new Hono();
app.use("*", cors());

// Keep-alive on every response: the mobile UI is all short polling requests,
// and without this header the browser treats each connection as one-shot —
// a new socket per poll that piles up past its ~6-connections-per-origin
// limit. With keep-alive the same pool handles every tick.
app.use("*", async (c, next) => {
  await next();
  c.header("Connection", "keep-alive");
  c.header("Keep-Alive", "timeout=25");
});

// Mobile UI. Registered BEFORE serveStatic so the static middleware doesn't
// swallow "/m" (it would 404 looking for a file of that name).
// Read the file into a string rather than streaming Bun.file: streaming left
// `content-length: 0` on the response, which some browsers treat as an empty
// document (the page simply never appeared on the phone). no-store keeps a
// stale copy from hanging around after an update.
app.get("/m", async (c) => {
  const html = await Bun.file(join(PUBLIC_DIR, "mobile.html")).text();
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(html).length),
      "Cache-Control": "no-store, must-revalidate",
    },
  });
});

app.use("/*", serveStatic({ root: PUBLIC_DIR }));

app.get("/config", (c) => c.json({ theme: DEFAULT_THEME }));

app.get("/sessions", async (c) => {
  const sessions = await sendCommand({ action: "list" });
  const withStatus = sessions.map((s) => {
    const st = getStatus(s.name);
    return { ...s, status: st?.status ?? "idle", statusMessage: st?.message ?? "" };
  });
  return c.json(withStatus);
});

// --- branch-agent session hierarchy ---------------------------------------
// The branch-agent-mechanism records each branch as a STATUS.md under
// ~/.codebuddy/run-state/. What matters here is NOT the directory layout but
// the SESSION parent/child relationship recorded in each STATUS.md's
// "## 分支身份" table:
//   分支 | 父任务 | 当前状态 | session | tmux | 更新于
//   - tmux  column: this branch's real tmux session name.
//   - 父任务 column: "由 <X> 发起（...）" — X is the PARENT tmux session name.
//                     "由人主会话发起" / "由人发起" means this is a root.
// We build a tmux-session tree from (tmux -> parent tmux), ignoring directories
// entirely. Each node is a real session window; there are no folder levels.
interface BranchNode {
  name: string; // this branch's real tmux session name
  parent: string | null; // parent tmux session name, or null if a root
}

const RUN_STATE_ROOT = join(homedir(), ".codebuddy", "run-state");
let branchCache: { at: number; nodes: BranchNode[] } | null = null;
const BRANCH_TTL_MS = 3000;

// A tmux cell may carry trailing prose, e.g. "main（主会话直连、无独立 tmux）".
// Take the leading token before any whitespace or CJK/ASCII bracket.
function cleanSessionName(raw: string): string {
  return raw.split(/[（(【\[\s]/)[0].trim();
}

// Extract the parent tmux name from a "父任务" cell like "由 X 发起（...）".
// Returns null for human/root origins ("由人主会话发起", "由人发起", empty, ...).
function parseParent(raw: string): string | null {
  if (!raw) return null;
  const m = raw.match(/由\s*([^\s（(【\[发]+)\s*发起/);
  if (!m) return null;
  const who = m[1].trim();
  if (!who || who.includes("人")) return null; // human-originated => root
  return who;
}

// Parse the "## 分支身份" table's first data row. Tolerant of column order by
// matching the header row. Returns {} if the section/table isn't found.
function parseIdentity(md: string): { tmux?: string; parent?: string } {
  const secIdx = md.indexOf("## 分支身份");
  if (secIdx === -1) return {};
  const rest = md.slice(secIdx).split("\n");
  let headerCols: string[] | null = null;
  for (let i = 1; i < rest.length; i++) {
    const line = rest[i];
    if (line.startsWith("## ") && i > 1) break; // next section
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((s) => s.trim()).filter((s) => s.length > 0);
    if (cells.length === 0) continue;
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator row
    if (!headerCols) {
      headerCols = cells;
      continue;
    }
    const tmuxIdx = headerCols.findIndex((h) => h.toLowerCase() === "tmux");
    const parentIdx = headerCols.findIndex((h) => h === "父任务");
    return {
      tmux: tmuxIdx >= 0 ? cells[tmuxIdx] : undefined,
      parent: parentIdx >= 0 ? cells[parentIdx] : undefined,
    };
  }
  return {};
}

function scanRunState(): BranchNode[] {
  if (!existsSync(RUN_STATE_ROOT)) return [];
  const byName = new Map<string, BranchNode>();
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes("STATUS.md")) {
      try {
        const md = readFileSync(join(dir, "STATUS.md"), "utf8");
        const id = parseIdentity(md);
        if (id.tmux) {
          const name = cleanSessionName(id.tmux);
          if (name) {
            // De-dup by tmux name; last writer wins (latest STATUS.md).
            byName.set(name, { name, parent: parseParent(id.parent || "") });
          }
        }
      } catch {
        /* skip unreadable / non-standard STATUS.md */
      }
    }
    for (const e of entries) {
      if (e.startsWith(".")) continue;
      const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) walk(full);
      } catch {
        /* ignore */
      }
    }
  };
  walk(RUN_STATE_ROOT);
  return [...byName.values()];
}

app.get("/branches", (c) => {
  const now = Date.now();
  if (!branchCache || now - branchCache.at > BRANCH_TTL_MS) {
    branchCache = { at: now, nodes: scanRunState() };
  }
  return c.json(branchCache.nodes);
});

app.post("/sessions", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name = body.name || `session-${Date.now()}`;
  if (await sendCommand({ action: "create", name, cwd: SESSION_CWD })) {
    return c.json({ success: true, name });
  }
  return c.json({ success: false, error: "Session already exists or creation failed" }, 400);
});

app.delete("/sessions/:name", async (c) => {
  const name = c.req.param("name");
  if (name === "default") {
    return c.json({ success: false, error: "Cannot delete default session" }, 400);
  }
  if (await sendCommand({ action: "kill", name })) {
    clearStatus(name);
    return c.json({ success: true });
  }
  return c.json({ success: false, error: "Session not found" }, 404);
});

app.patch("/sessions/:name", async (c) => {
  const oldName = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const newName = body.name;
  if (!newName) {
    return c.json({ success: false, error: "Missing new name" }, 400);
  }
  if (oldName === "default") {
    return c.json({ success: false, error: "Cannot rename default session" }, 400);
  }
  if (await sendCommand({ action: "rename", oldName, newName })) {
    renameStatus(oldName, newName);
    return c.json({ success: true, name: newName });
  }
  return c.json({ success: false, error: "Rename failed - session not found or name taken" }, 400);
});

app.post("/exec/:session", async (c) => {
  const session = c.req.param("session");
  const body = await c.req.json().catch(() => ({}));
  const keys = body.cmd;
  if (!keys) {
    return c.json({ success: false, error: "Missing cmd" }, 400);
  }
  if (await sendCommand({ action: "keys", session, keys })) {
    return c.json({ success: true });
  }
  return c.json({ success: false, error: "Session not found" }, 404);
});

// Force a full redraw of a session: ask tmux to refresh all clients attached
// to that session, which re-pushes a clean frame. Used by the client's "重绘"
// action to recover from a corrupted browser-side render (e.g. WebGL glitch).
app.post("/redraw/:session", async (c) => {
  const session = c.req.param("session");
  try {
    const p = spawn(["tmux", "refresh-client", "-t", session]);
    await p.exited;
    return c.json({ success: true });
  } catch {
    return c.json({ success: false }, 500);
  }
});

// --- Mobile input API -------------------------------------------------------
// The mobile UI decouples input from the terminal: you type in a normal text
// box and press send, instead of driving the xterm cursor directly. Text is
// typed into the session literally, then Enter is pressed separately (see
// sendText in pty.ts for why the two steps must be separate).
app.post("/m/send/:session", async (c) => {
  const session = c.req.param("session");
  const body = await c.req.json().catch(() => ({}));
  const text = typeof body.text === "string" ? body.text : "";
  if (!text) return c.json({ success: false, error: "Missing text" }, 400);
  const ok = await sendCommand({ action: "sendText", session, text });
  return ok ? c.json({ success: true }) : c.json({ success: false }, 404);
});

// Named keys the mobile key bar may send. Whitelisted so a crafted request
// can't push arbitrary tmux key syntax (or commands) into a session.
const ALLOWED_KEYS = new Set([
  "Escape", "Enter", "Tab", "BTab", "Space", "BSpace",
  "Up", "Down", "Left", "Right", "Home", "End", "PageUp", "PageDown",
  "C-c", "C-d", "C-r", "C-l", "C-a", "C-e", "C-u", "C-k", "C-z", "C-p", "C-n",
  "y", "n", "q", "1", "2", "3",
]);

app.post("/m/key/:session", async (c) => {
  const session = c.req.param("session");
  const body = await c.req.json().catch(() => ({}));
  const key = typeof body.key === "string" ? body.key : "";
  if (!ALLOWED_KEYS.has(key)) {
    return c.json({ success: false, error: "Key not allowed" }, 400);
  }
  const ok = await sendCommand({ action: "sendKey", session, key });
  return ok ? c.json({ success: true }) : c.json({ success: false }, 404);
});

// Snapshot a session's visible buffer as text (with ANSI colours).
// The mobile UI renders this as flowing HTML instead of a fixed cols x rows
// grid: a phone can't show the session's real width, and forcing xterm to that
// geometry is what made the mobile view impossible to fit to the screen.
//   -p print to stdout, -e keep colours, -J unwrap lines tmux hard-wrapped
app.get("/m/capture/:session", async (c) => {
  const session = c.req.param("session");
  const linesParam = parseInt(c.req.query("lines") || "120", 10);
  const lines = Math.min(Math.max(Number.isNaN(linesParam) ? 120 : linesParam, 20), 20000);
  try {
    const p = spawn(["tmux", "capture-pane", "-p", "-e", "-J", "-t", session, "-S", `-${lines}`]);
    const text = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return c.json({ ok: false, error: "capture failed" }, 404);

    // 304 when nothing changed. The mobile client re-polls the whole window
    // on every tick; on a flaky link those unchanged payloads were the bulk
    // of the traffic, and each full copy was another chance to stall. An
    // unchanged reply now costs ~200 bytes. Session is part of the tag so two
    // sessions with momentarily identical content can't false-match.
    const tag = `"${Bun.hash(text).toString(16)}-${session}-${lines}"`;
    const inm = c.req.header("if-none-match");
    if (inm === tag) return c.body(null, 304, { ETag: tag });

    const body = JSON.stringify({ ok: true, text });
    // Terminal output is highly repetitive, so gzip buys roughly 10x here. That
    // matters: on a phone this link measured ~8KB/s with heavy retransmits, and
    // an uncompressed capture simply never finished arriving.
    if ((c.req.header("accept-encoding") || "").includes("gzip")) {
      const gz = Bun.gzipSync(new TextEncoder().encode(body));
      return new Response(gz, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Encoding": "gzip",
          "Cache-Control": "no-store",
          "ETag": tag,
        },
      });
    }
    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "ETag": tag,
      },
    });
  } catch {
    return c.json({ ok: false, error: "capture failed" }, 500);
  }
});

// Long-polling variant for the mobile UI. Plain polling meant every content
// update waited out the poll interval PLUS a full RTT (2-3s felt latency on
// this link); a WebSocket stream fixed that but left zombies behind on every
// network switch. Long-polling gets stream-like latency (change detected
// ~300ms after it happens, response carries the data) while staying a plain
// request that fails cleanly and never outlives its hold time.
//   - client passes its last known etag
//   - server re-captures every 300ms; on change returns 200 {text, etag}
//   - on hold timeout (20s) returns 304 so the client re-arms immediately
//   - aborting the fetch (session switch) cancels the hold via the signal
// Last served capture per session+lines key, so a watch can send only what's
// new. Terminal output is append-mostly: when the new capture contains the
// previous one, the delta is just the tail — tens of bytes on a live session
// instead of the whole window. A large block on a lossy link is exactly what
// stalls (one loss = retransmit the whole block), which is why the first
// WebSocket generation (tiny chunks) felt low-latency where full snapshots choke.
//
// The delta is only valid when the client PROVES it has the base: its etag
// must equal the etag of the text we last served for that key. Otherwise we
// send the full window — a fresh page load, a second watcher, or a client that
// fell behind all get the full copy, never a delta applied to the wrong base.
const lastServed = new Map<string, { text: string; tag: string }>();

app.get("/m/watch/:session", async (c) => {
  const session = c.req.param("session");
  const linesParam = parseInt(c.req.query("lines") || "120", 10);
  const lines = Math.min(Math.max(Number.isNaN(linesParam) ? 120 : linesParam, 20), 2000);
  const clientTag = c.req.query("etag") || "";
  const deadline = Date.now() + 20000;
  const signal = c.req.raw.signal;
  const key = `${session}:${lines}`;

  const captureOnce = async () => {
    const p = spawn(["tmux", "capture-pane", "-p", "-e", "-J", "-t", session, "-S", `-${lines}`]);
    const text = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    return text;
  };

  // Delta computation, gated on the client actually owning the base text.
  // Tail whitespace is normalised before comparing: tmux pads the capture to
  // the pane's geometry, and that padding shifts as lines are appended — an
  // untrimmed comparison fails to match even a pure append (measured: 423/440
  // common prefix, then padding mismatch). The client trims when rendering
  // anyway, so this is invisible to it.
  const deltaFor = (text: string, tag: string): { append: string } | { full: string } => {
    const prev = lastServed.get(key);
    lastServed.set(key, { text, tag });
    if (!prev || prev.tag !== clientTag) return { full: text };
    const prevText = prev.text.replace(/\s+$/, "");
    const currText = text.replace(/\s+$/, "");
    if (prevText === currText) return { full: text };
    // Window slid forward (old lines fell off the top) + new lines appended:
    // the new capture contains the previous one somewhere inside it.
    const idx = currText.indexOf(prevText);
    if (idx >= 0) {
      const tail = currText.slice(idx + prevText.length);
      if (tail.length > 0) return { append: tail };
    }
    // No slide: lines were appended at the end only.
    let p = 0;
    const minLen = Math.min(prevText.length, currText.length);
    while (p < minLen && prevText[p] === currText[p]) p++;
    if (p === prevText.length && currText.length > prevText.length) return { append: currText.slice(p) };
    return { full: text };
  };

  try {
    while (Date.now() < deadline) {
      if (signal.aborted) return new Response(null, { status: 499 });
      const text = await captureOnce();
      if (text === null) return c.json({ ok: false, error: "session gone" }, 404);
      const tag = `"${Bun.hash(text).toString(16)}-${session}-${lines}"`;
      if (tag !== clientTag) {
        const delta = deltaFor(text, tag);
        const body = JSON.stringify(
          delta.append !== undefined
            ? { ok: true, append: delta.append, etag: tag }
            : { ok: true, text, etag: tag },
        );
        if ((c.req.header("accept-encoding") || "").includes("gzip")) {
          return new Response(Bun.gzipSync(new TextEncoder().encode(body)), {
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Content-Encoding": "gzip",
              "Cache-Control": "no-store",
              "ETag": tag,
            },
          });
        }
        return new Response(body, {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "ETag": tag,
          },
        });
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    // Nothing changed during the hold: tell the client to keep waiting.
    return new Response(null, {
      status: 304,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return c.json({ ok: false, error: "watch failed" }, 500);
  }
});

// --- Shared sidebar layout (server-side) -----------------------------------
// Groups/pins/order used to live in each browser's localStorage, which is
// per-origin AND per-device: the phone could never see the desktop's groups.
// The layout is now a small JSON file the server owns, so every device reads
// and writes the same one. The desktop stays the main editor; the phone only
// reads. Keys mirror the old localStorage names so migrating is a copy.
import { writeFileSync, readFileSync } from "fs";

const LAYOUT_FILE = join(homedir(), ".termx-layout.json");
const LAYOUT_KEYS = [
  "termx-groups", "termx-session-group", "termx-pinned",
  "termx-pinned-collapsed", "termx-session-order",
] as const;

function readLayout(): Record<string, unknown> {
  try {
    const d = JSON.parse(readFileSync(LAYOUT_FILE, "utf8"));
    return typeof d === "object" && d !== null ? d : {};
  } catch {
    return {};
  }
}

app.get("/layout", (c) => c.json(readLayout()));

// Replacing the whole layout keeps the API dumb (no merge logic to get wrong);
// the desktop UI is the only writer and it always has the full state at hand.
// Body: { "termx-groups": "...json string...", ... } — values stay JSON
// strings so the client code can treat them exactly like localStorage values.
app.post("/layout", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  if (typeof body !== "object" || body === null) {
    return c.json({ ok: false, error: "invalid body" }, 400);
  }
  const next: Record<string, string> = {};
  for (const k of LAYOUT_KEYS) {
    if (typeof body[k] === "string") next[k] = body[k];
  }
  if (Object.keys(next).length === 0) {
    return c.json({ ok: false, error: "no layout keys in body" }, 400);
  }
  try {
    writeFileSync(LAYOUT_FILE, JSON.stringify(next, null, 2));
    broadcastLayoutChanged();
    return c.json({ ok: true });
  } catch {
    return c.json({ ok: false, error: "write failed" }, 500);
  }
});

// Push layout changes to any listening device (SSE, same channel as statuses).
function broadcastLayoutChanged(): void {
  broadcast({ layout: "changed" });
}

// Agent status reporting (called by CodeBuddy hook scripts).
app.post("/hook/:session", async (c) => {
  const session = c.req.param("session");
  const body = await c.req.json().catch(() => ({}));
  if (!isStatus(body.status)) {
    return c.json({ ok: false, error: "Invalid status" }, 400);
  }
  const message = typeof body.message === "string" ? body.message.slice(0, 500) : "";
  setStatus(session, body.status, message);
  return c.json({ ok: true });
});

// Server-Sent Events: push status changes to the browser.
app.get("/events", (c) => {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      let dead = false;
      const cleanup = () => {
        if (dead) return;
        dead = true;
        clearInterval(ping);
        unsub();
        try { controller.close(); } catch {}
      };
      const send = (payload: string) => {
        if (dead) return;
        // A failed write means the client is gone (phone switched networks,
        // tab killed, ...). Swallowing it let zombie streams pile up: the dead
        // TCP connection still counts against the browser's ~6-per-origin
        // connection limit, and once enough accumulate the page can't load
        // anything at all — the recurring "手机连不上" failure mode.
        try {
          controller.enqueue(enc.encode(payload));
        } catch {
          cleanup();
        }
      };
      // Initial full snapshot.
      send(`data: ${JSON.stringify({ type: "snapshot", statuses: getAllStatus() })}\n\n`);
      const unsub = subscribe(send);
      const ping = setInterval(() => send(`: ping\n\n`), 15000);
      c.req.raw.signal.addEventListener("abort", cleanup);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

type WsData = { session: string; cols: number; rows: number };
const wsPtyMap = new Map<unknown, PtyHandle>();

await sendCommand({ action: "ensureDefault", cwd: SESSION_CWD });

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: "0.0.0.0",
  // Bun cuts requests off after 10s by default. A phone on mobile data pulling
  // a capture can legitimately take longer than that; the truncated responses
  // showed up as connections stuck in FIN-WAIT and a client that "can't connect".
  idleTimeout: 30,
  fetch(req, server) {
    const url = new URL(req.url);
    const wsMatch = url.pathname.match(/^\/ws\/([^/]+)$/);

    if (wsMatch && req.headers.get("upgrade") === "websocket") {
      const session = decodeURIComponent(wsMatch[1]);
      const resize = url.searchParams.get("resize");
      let cols = 120, rows = 30;
      if (resize) {
        const [c, r] = resize.split(",").map(Number);
        if (c > 0) cols = c;
        if (r > 0) rows = r;
      }
      const success = server.upgrade(req, { data: { session, cols, rows } });
      return success ? undefined : new Response("WebSocket upgrade failed", { status: 500 });
    }

    return app.fetch(req);
  },
  websocket: {
    // Bun closes idle websockets after ~120s by default, which silently kills a
    // terminal you just left sitting there. Raise it to the max and rely on the
    // client heartbeat to keep the connection (and any proxy in between) warm.
    idleTimeout: 960,
    async open(ws) {
      const { session, cols, rows } = ws.data;
      console.log(`[WS] open session=${session} cols=${cols} rows=${rows}`);

      const pty = await sendCommand({ action: "attach", session, cols, rows, cwd: SESSION_CWD });
      if (!pty) {
        console.error(`[WS] Failed to attach session: ${session}`);
        ws.close(1011, "Failed to attach session");
        return;
      }

      wsPtyMap.set(ws, pty);

      pty.onData((data) => {
        if (ws.readyState === 1) {
          ws.send(data);
        }
      });

      pty.onExit((code) => {
        console.log(`[WS] PTY exited code=${code} session=${session}`);
        wsPtyMap.delete(ws);
        if (ws.readyState === 1) {
          ws.close(1000, "PTY exited");
        }
      });
    },
    message(ws, message) {
      const pty = wsPtyMap.get(ws);
      if (!pty) return;

      if (typeof message === "string") {
        try {
          const parsed = JSON.parse(message);
          if (parsed.type === "resize" && typeof parsed.cols === "number" && typeof parsed.rows === "number") {
            if (process.env.TERMX_RESIZE_LOG) {
              console.log(`[RESIZE] session=${ws.data.session} -> ${parsed.cols}x${parsed.rows}`);
            }
            pty.resize(parsed.cols, parsed.rows);
            return;
          }
          // Client heartbeat: answer so the client can tell a live connection
          // from a silently-dropped one. Must not reach the PTY as literal text.
          if (parsed.type === "ping") {
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: "pong" }));
            return;
          }
        } catch {}
        pty.write(message);
      } else if (message instanceof ArrayBuffer) {
        pty.write(new TextDecoder().decode(message));
      } else if (message instanceof Uint8Array) {
        pty.write(new TextDecoder().decode(message));
      }
    },
    close(ws) {
      const pty = wsPtyMap.get(ws);
      if (pty) {
        console.log(`[WS] close, killing PTY`);
        pty.kill();
        wsPtyMap.delete(ws);
      }
    },
  },
});

console.log(`Terminal server running: http://${server.hostname}:${server.port}`);
