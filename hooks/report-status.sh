#!/usr/bin/env bash
# Report CodeBuddy Code agent status to the termx server.
#
# Usage (from settings.json hook command):
#   report-status.sh <status-label>
#
# <status-label> is one of: running | waiting | done | error | idle
# Reads the hook JSON from stdin (used to refine status and prevent loops).
# Figures out which tmux session it lives in via $TMUX_PANE, then POSTs to
#   http://127.0.0.1:$TERMX_PORT/hook/<session>
#
# Always exits 0 so it never blocks the agent. Debug goes to stderr.

set -u

STATUS="${1:-running}"
PORT="${TERMX_PORT:-7681}"
HOST="${TERMX_HOST:-127.0.0.1}"

# Read hook payload from stdin (may be empty).
PAYLOAD="$(cat 2>/dev/null || true)"

# --- Refine status from event payload ---------------------------------------
EVENT="$(printf '%s' "$PAYLOAD" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/')"

case "$EVENT" in
  Stop)
    # Avoid infinite loop: skip if CodeBuddy already continued from a stop hook.
    if printf '%s' "$PAYLOAD" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
      exit 0
    fi
    STATUS="done"
    ;;
  PostToolUse)
    # Tool failure -> error, otherwise keep running.
    if printf '%s' "$PAYLOAD" | grep -q '"success"[[:space:]]*:[[:space:]]*false'; then
      STATUS="error"
    else
      STATUS="running"
    fi
    ;;
  Notification)
    # Distinguish permission requests (block on user -> yellow "waiting") from
    # idle reminders (agent finished, sitting idle -> white "done").
    # Match the notification_type VALUE precisely: use "permission_prompt", NOT a
    # loose "permission" match — the payload also carries a "permission_mode" field
    # that would otherwise make EVERY notification look like a permission request
    # (that bug made finished tasks blink yellow).
    if printf '%s' "$PAYLOAD" | grep -q 'permission_prompt'; then
      STATUS="waiting"
    elif printf '%s' "$PAYLOAD" | grep -q 'idle_prompt'; then
      STATUS="done"
    fi
    ;;
  PermissionRequest|PermissionDenied)
    # Explicit permission-request events (if the runtime emits them).
    STATUS="waiting"
    ;;
  SessionEnd)
    STATUS="idle"
    ;;
esac

# --- Resolve tmux session name ----------------------------------------------
# $TMUX_PANE is set for any process running inside tmux.
SESSION=""
if [ -n "${TMUX_PANE:-}" ] && command -v tmux >/dev/null 2>&1; then
  SESSION="$(tmux display-message -p -t "$TMUX_PANE" '#{session_name}' 2>/dev/null)"
fi

if [ -z "$SESSION" ]; then
  # Not inside tmux (or lookup failed) -> nothing to report to.
  echo "termx-hook: no tmux session (TMUX_PANE=${TMUX_PANE:-unset}), skip" >&2
  exit 0
fi

# --- Report -----------------------------------------------------------------
# URL-encode nothing fancy; tmux session names are usually safe. Escape quotes in message.
MSG="${EVENT:-$STATUS}"
BODY="{\"status\":\"$STATUS\",\"message\":\"$MSG\"}"

if command -v curl >/dev/null 2>&1; then
  curl -s -m 5 -X POST \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    "http://$HOST:$PORT/hook/$SESSION" >/dev/null 2>&1 \
    && echo "termx-hook: reported $STATUS for session=$SESSION" >&2 \
    || echo "termx-hook: report failed (server down?) status=$STATUS session=$SESSION" >&2
else
  echo "termx-hook: curl not found, cannot report" >&2
fi

exit 0
