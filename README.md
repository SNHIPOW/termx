# @zuppif/termx

Web-based terminal server using Bun + Hono + tmux. Run it anywhere, get a browser terminal.

**Mobile-optimized** — perfect for sandboxes, cloud environments, and using AI assistants on the go.

![termx main interface](media/main.png)

![termx mobile interface](media/mobile.png)

## Quick Start (no install)

```bash
bunx @zuppif/termx
bunx @zuppif/termx -p 3000
bunx @zuppif/termx -p 8080 -t Dracula
bunx @zuppif/termx --port 3000 --theme "Tokyo Night"
```

## Install

```bash
bun install -g @zuppif/termx
```

## Usage

```bash
termx
```

Opens on `http://localhost:7681`. New sessions start in your home directory
(override with `TERMX_CWD`).

## Options

| Flag | Short | Description | Default |
|------|-------|-------------|---------|
| `--port` | `-p` | Server port | `7681` |
| `--theme` | `-t` | Default theme | `Dark` |

```bash
termx --port 3000 --theme Dracula
termx -p 3000 -t "Tokyo Night"
```

## Themes

- Dark
- Dracula
- Monokai
- Nord
- Gruvbox
- Tokyo Night
- Atom One Dark
- Catppuccin
- Light

## Mobile UI (`/m`)

The desktop layout doesn't work well on a phone, so there's a separate mobile
page on the **same port**:

```
http://<host>:7681/m
```

It's app-shaped rather than desktop-shaped:

- **Two screens** — a session list, then tap into a session. Branch agents are
  nested under their parent, same as the desktop sidebar.
- **Input is decoupled from the terminal.** The terminal view is read-only
  (`disableStdin`); you type in a normal text box at the bottom and press send.
  This avoids fighting the mobile keyboard over cursor position, and means
  autocorrect can't scribble into a live TUI.
- **Key bar** for things a phone keyboard can't produce: `Esc`, `⇧Tab`
  (switches the agent's mode — the main reason this bar exists), arrows, Enter,
  plus an expandable row with `Tab`, `y`/`n`, `^C`, `^D`, `^R`, PgUp/PgDn,
  Home/End. `Ctrl` is sticky: tap it, then tap a letter.
- **A+ / A−** font size control (remembered), auto-sized for the screen on
  first run.
- **Touch scrolling** is implemented explicitly (xterm doesn't turn touch drags
  into scrolls) and the keyboard is handled through `visualViewport`, so the
  composer isn't hidden behind it on iOS.

How text reaches the agent: the server types it with `tmux send-keys -l`, waits
a moment, then sends `Enter` as a separate key. Both steps are required — TUI
prompts debounce their input and swallow an `Enter` that arrives in the same
frame as the text.

## Session Sidebar

Sessions are listed as cards with a live status dot. Beyond plain switching:

- **Pin** frequently used sessions to a section at the top (right-click a card).
- **Groups** — create your own groups and drag cards between them.
- **Drag to reorder** within a section.
- **Seamless switching** — every session keeps its own live terminal pane and
  socket, so switching never re-attaches tmux, replays scrollback, or blanks the
  screen.
- **Redraw button** (toolbar) forces a clean repaint of the visible terminal if
  it ever renders wrong.
- **Export/Import config** (gear icon) — the sidebar layout (groups, pins,
  order, theme) lives in `localStorage`, which is scoped per origin. If you
  reach termx through a different URL (localhost vs LAN IP vs a tunnel), the
  sidebar starts empty. Export on the old URL, import on the new one.

### Branch agents (optional)

If you use the branch-agent workflow, termx can render sub-agents nested under
their parent session. It reads `~/.codebuddy/run-state/**/STATUS.md` and uses the
`## 分支身份` table for the authoritative identity:

- the **`tmux`** column — the branch's real tmux session name;
- the **`父任务`** column written as `由 <parent> 发起` — the parent's tmux name
  (a human origin, e.g. `由人主会话发起`, marks a root).

Live sessions are then shown as a tree (parents collapsible, siblings
drag-sortable). Branches whose tmux session no longer exists are hidden. The
directory layout under `run-state/` is ignored — only the identity table matters.

## Agent Status (optional)

termx can show a live status dot on each session card, reflecting what the
CodeBuddy Code agent in that tmux session is doing:

| Dot | Status | Meaning |
|-----|--------|---------|
| 🟢 green | `running` | agent is actively working |
| 🟡 yellow (blink) | `waiting` | agent is asking for permission / your input |
| ⚪ white (blink) | `done` | agent finished — calms to gray once you view it |
| 🔴 red (blink) | `error` | a tool call failed |
| ⚫ gray | `idle` | session open, agent not doing anything |

This is driven by CodeBuddy Code hooks that POST to the termx server. Nothing
works until you wire the hooks into your `settings.json`.

### Setup

1. **Locate the hook script.** It ships in this repo at `hooks/report-status.sh`.
   Note its absolute path:

   ```bash
   realpath hooks/report-status.sh
   # e.g. /home/you/termx/hooks/report-status.sh
   ```

2. **Merge the hooks into your `settings.json`.** Use either the user-level file
   `~/.codebuddy/settings.json` or a project-level `<project>/.codebuddy/settings.json`.
   Copy the `hooks` block from `hooks/settings.example.json` and replace every
   `/ABS/PATH/TO` with the path from step 1. If your server isn't on port 7681,
   change `TERMX_PORT`.

   Minimal example (merge under the top-level `"hooks"` key):

   ```json
   {
     "hooks": {
       "SessionStart":     [{ "hooks": [{ "type": "command", "command": "TERMX_PORT=7681 bash /ABS/PATH/TO/report-status.sh idle",    "timeout": 10 }] }],
       "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "TERMX_PORT=7681 bash /ABS/PATH/TO/report-status.sh running", "timeout": 10 }] }],
       "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "TERMX_PORT=7681 bash /ABS/PATH/TO/report-status.sh running", "timeout": 10 }] }],
       "Notification":     [{ "hooks": [{ "type": "command", "command": "TERMX_PORT=7681 bash /ABS/PATH/TO/report-status.sh done",    "timeout": 10 }] }],
       "PermissionRequest":[{ "hooks": [{ "type": "command", "command": "TERMX_PORT=7681 bash /ABS/PATH/TO/report-status.sh waiting", "timeout": 10 }] }],
       "Stop":             [{ "hooks": [{ "type": "command", "command": "TERMX_PORT=7681 bash /ABS/PATH/TO/report-status.sh done",    "timeout": 10 }] }],
       "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "TERMX_PORT=7681 bash /ABS/PATH/TO/report-status.sh done",    "timeout": 10 }] }],
       "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "TERMX_PORT=7681 bash /ABS/PATH/TO/report-status.sh idle",    "timeout": 10 }] }]
     }
   }
   ```

   The full template is in [`hooks/settings.example.json`](hooks/settings.example.json).

3. **Activate.** Run `/hooks` inside CodeBuddy Code (or restart it) to pick up the
   new config. Already-running CodeBuddy sessions keep their old hook config —
   run `/hooks` in each, or restart them, or they'll report to the old port /
   miss new events.

### How it works

`report-status.sh` reads the hook JSON on stdin, resolves the current tmux session
via `$TMUX_PANE`, then `POST`s `{ status, message }` to `http://$TERMX_HOST:$TERMX_PORT/hook/<session>`.
The session name is percent-encoded, so names with spaces (`Terminal 1`) work.
The script always exits 0 so it can never block your agent, and refines the raw
label from the payload:

| Event | Status |
|-------|--------|
| `UserPromptSubmit` | `running` |
| `PostToolUse` | `running`, or `error` when the payload has `success:false` |
| `Notification` | `waiting` for `permission_prompt`, `done` for `idle_prompt` |
| `PermissionRequest` / `PermissionDenied` | `waiting` |
| `Stop` / `SubagentStop` | `done` (skipped when `stop_hook_active:true`) |
| `SessionStart` / `SessionEnd` | `idle` |

The browser receives updates over Server-Sent Events at `/events`. Repeated
reports of the same status keep their original timestamp, so a finished session
doesn't re-trigger the "unread" blink.

Env vars honored by the script:

| Var | Default | Purpose |
|-----|---------|---------|
| `TERMX_PORT` | `7681` | termx server port |
| `TERMX_HOST` | `127.0.0.1` | termx server host |
| `TERMX_HOOK_LOG` | *(unset)* | If set to a file path, log every hook event (debugging) |

`curl` and `tmux` must be available on `PATH` for reporting to work.

## Requirements

- [Bun](https://bun.sh) runtime
- `tmux` installed on the system
- `curl` (only if you use Agent Status hooks)

## Stack

- **Runtime**: Bun
- **HTTP**: Hono
- **Terminal**: tmux + Bun.Terminal
- **Frontend**: xterm.js

## API

### REST

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Terminal UI |
| GET | `/m` | Mobile UI |
| GET | `/sessions` | List sessions |
| POST | `/sessions` | Create session. Body: `{ name?: string }` |
| DELETE | `/sessions/:name` | Kill session (except "default") |
| PATCH | `/sessions/:name` | Rename session. Body: `{ name: string }` |
| POST | `/exec/:session` | Send command. Body: `{ cmd: string }` |
| POST | `/hook/:session` | Report agent status. Body: `{ status, message }` (used by hooks) |
| POST | `/redraw/:session` | Ask tmux to re-emit a clean frame (`refresh-client`) |
| GET | `/events` | Server-Sent Events stream of session status updates |
| GET | `/branches` | Branch-agent tree: `[{ name, parent }]` parsed from `run-state` STATUS.md |
| POST | `/m/send/:session` | Mobile: type `{ text }` into the session, then Enter (two-stage) |
| POST | `/m/key/:session` | Mobile: send one named key `{ key }` (whitelisted) |

### WebSocket

Connect to `/ws/:session?resize=cols,rows` (the `resize` param is optional and
omitted when the client can't yet measure a sane size).

**Client -> Server:**
- Raw text/binary: PTY stdin
- JSON `{ type: "resize", cols, rows }`: resize. Only sent when the grid actually
  changes — tmux does a full-screen redraw on *every* resize it receives.
- JSON `{ type: "ping" }`: heartbeat (every 25s)

**Server -> Client:**
- Raw binary: PTY stdout
- JSON `{ type: "pong" }`: heartbeat reply

The client keeps the socket alive with that heartbeat, detects half-open
connections (no pong for 75s), and reconnects automatically with backoff — plus
on `visibilitychange` / `focus` / `online`. Server-side `idleTimeout` is raised
to 960s so a terminal you simply left alone isn't dropped.

## File Structure

```
src/
├── index.ts   # HTTP routes, WebSocket handler
├── pty.ts     # tmux session management via sendCommand()
└── status.ts  # in-memory agent status store + SSE broadcast
public/
├── index.html  # desktop frontend (xterm.js)
└── mobile.html # mobile UI (list + session, decoupled input)
hooks/
├── report-status.sh       # CodeBuddy hook -> POST /hook/:session
└── settings.example.json  # hook config template for settings.json
```

## Architecture

```
┌─────────────┐     HTTP/WS      ┌─────────────┐     Bun.Terminal    ┌─────────┐
│   Browser   │ <--------------> │  Bun Server │ <-----------------> │  tmux   │
│  (xterm.js) │                  │   (Hono)    │                     │ session │
└─────────────┘                  └─────────────┘                     └─────────┘
```

## Development

```bash
bun install
bun run dev     # hot reload
bun run start   # production
```

## Config

```bash
termx --port 3000              # CLI flag
PORT=3000 termx                # env var
TERMX_CWD=/path/to/dir termx   # where new sessions start
```

New sessions start in your home directory by default. Override with `TERMX_CWD`.

## Docker

```dockerfile
FROM oven/bun
RUN apt-get update && apt-get install -y tmux
WORKDIR /app
COPY . .
RUN bun install
CMD ["bun", "run", "start"]
```
