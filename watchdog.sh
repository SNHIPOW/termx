#!/bin/bash
# termx watchdog — keeps the terminal server alive and healthy.
#
# Why this exists: the server degrades over hours (memory climbing, stale
# connections). Root cause is being hunted with the [HEALTH] logs; until it's
# pinned, this converts a multi-hour "phone can't connect" outage into a
# few seconds of reconnect.
#
# Checks every 30s:
#   1. port listening           -> else start the server
#   2. /m answers within 5s     -> else restart it
#   3. RSS under MEM_LIMIT_KB   -> else restart it (slow leak containment)
# Actions are logged to /tmp/termx-watchdog.log with the reason.
#
# Single instance via pidfile. Start:   bash watchdog.sh &
# Stop:   kill $(cat /tmp/termx-watchdog.pid)

PORT="${PORT:-17681}"
MEM_LIMIT_KB="${MEM_LIMIT_KB:-700000}"
DIR="$(cd "$(dirname "$0")" && pwd)"
LOG=/tmp/termx-watchdog.log
PIDFILE=/tmp/termx-watchdog.pid
BUN=/home/kkunwu/.bun/bin/bun

if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "watchdog already running (pid $(cat "$PIDFILE"))" >&2
  exit 0
fi
echo $$ > "$PIDFILE"
trap 'rm -f "$PIDFILE"' EXIT

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

server_pid() {
  ss -tlnpH "sport = :$PORT" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1
}

start_server() {
  (cd "$DIR" && PORT="$PORT" setsid "$BUN" run src/index.ts >>/tmp/termx.log 2>&1 </dev/null &)
}

log "watchdog started (pid $$, port $PORT, mem limit ${MEM_LIMIT_KB}KB)"

while true; do
  sleep 30
  PID=$(server_pid)

  # 1. not listening at all
  if [ -z "$PID" ]; then
    log "port $PORT not listening — starting server"
    start_server
    sleep 8
    continue
  fi

  # 2. listening but not answering
  if ! timeout 5 curl -s -o /dev/null "http://127.0.0.1:$PORT/m"; then
    log "pid $PID not answering /m — restarting"
    kill "$PID" 2>/dev/null
    sleep 3
    start_server
    sleep 8
    continue
  fi

  # 3. memory over budget (slow degradation containment)
  RSS=$(awk '/VmRSS/{print $2}' "/proc/$PID/status" 2>/dev/null)
  if [ -n "$RSS" ] && [ "$RSS" -gt "$MEM_LIMIT_KB" ]; then
    log "pid $PID rss ${RSS}KB > ${MEM_LIMIT_KB}KB — restarting"
    kill "$PID" 2>/dev/null
    sleep 3
    start_server
    sleep 8
    continue
  fi
done
