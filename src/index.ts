#!/usr/bin/env bun
import { join } from "path";
import { homedir } from "os";
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
      const send = (payload: string) => {
        try {
          controller.enqueue(enc.encode(payload));
        } catch {}
      };
      // Initial full snapshot.
      send(`data: ${JSON.stringify({ type: "snapshot", statuses: getAllStatus() })}\n\n`);
      const unsub = subscribe(send);
      const ping = setInterval(() => send(`: ping\n\n`), 30000);
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(ping);
        unsub();
        try {
          controller.close();
        } catch {}
      });
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
            pty.resize(parsed.cols, parsed.rows);
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
