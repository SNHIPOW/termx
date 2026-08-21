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
cd /your/project
termx
```

Opens on `http://localhost:7681`. Sessions start in the directory you ran the command from.

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
       "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "TERMX_PORT=7681 bash /ABS/PATH/TO/report-status.sh idle",    "timeout": 10 }] }]
     }
   }
   ```

   The full template is in [`hooks/settings.example.json`](hooks/settings.example.json).

3. **Activate.** Run `/hooks` inside CodeBuddy Code (or restart it) to pick up the
   new config.

### How it works

`report-status.sh` reads the hook JSON on stdin, resolves the current tmux session
via `$TMUX_PANE`, then `POST`s `{ status, message }` to `http://127.0.0.1:$TERMX_PORT/hook/<session>`.
The script always exits 0 so it can never block your agent, and refines the raw
label from the payload (e.g. `Notification` → `waiting` only for a real
`permission_prompt`, `PostToolUse` with `success:false` → `error`). The browser
receives updates over Server-Sent Events at `/events`.

Env vars honored by the script:

| Var | Default | Purpose |
|-----|---------|---------|
| `TERMX_PORT` | `7681` | termx server port |
| `TERMX_HOST` | `127.0.0.1` | termx server host |

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
| GET | `/sessions` | List sessions |
| POST | `/sessions` | Create session. Body: `{ name?: string }` |
| DELETE | `/sessions/:name` | Kill session (except "default") |
| PATCH | `/sessions/:name` | Rename session. Body: `{ name: string }` |
| POST | `/exec/:session` | Send command. Body: `{ cmd: string }` |
| POST | `/hook/:session` | Report agent status. Body: `{ status, message }` (used by hooks) |
| GET | `/events` | Server-Sent Events stream of session status updates |

### WebSocket

Connect to `/ws/:session?resize=cols,rows`

**Client -> Server:**
- Raw text/binary: PTY stdin
- JSON `{ type: "resize", cols: number, rows: number }`: resize

**Server -> Client:**
- Raw binary: PTY stdout

## File Structure

```
src/
├── index.ts   # HTTP routes, WebSocket handler
├── pty.ts     # tmux session management via sendCommand()
└── status.ts  # in-memory agent status store + SSE broadcast
public/
└── index.html # xterm.js frontend
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
```

Sessions start in `process.cwd()` - wherever you run the command.

## Docker

```dockerfile
FROM oven/bun
RUN apt-get update && apt-get install -y tmux
WORKDIR /app
COPY . .
RUN bun install
CMD ["bun", "run", "start"]
```
