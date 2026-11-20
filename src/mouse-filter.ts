// Strip terminal mouse-reporting enable sequences (DECSET 1000/1002/1003/
// 1005/1006/1015) from the PTY->WebSocket stream.
//
// Claude Code enables application mouse reporting; through tmux that turns
// drag-to-select in the browser terminal into mouse events for the app —
// text selection stops working. CodeBuddy sessions don't enable it, which is
// why the two CLIs behave differently in the desktop view. Removing the
// enable sequences makes every session behave like a CodeBuddy one: drag
// selects, the app just doesn't get mouse input (it falls back to keyboard).
//
// Byte-level on purpose: the patterns are pure ASCII, so they can never
// collide with UTF-8 continuation bytes (all >= 0x80), and sequences that
// straddle a chunk boundary are handled by carrying the tail forward.
// Disable sequences ('l') pass through untouched — xterm.js safely ignores
// disabling a mode that never got enabled.

const MOUSE_MODES = new Set(["1000", "1002", "1003", "1005", "1006", "1015"]);
const MAX_CSI = 24; // longest sequence we're willing to hold in the carry

const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface MouseStripper {
  /** Filter one data chunk; returns the bytes to forward. */
  push(chunk: Uint8Array): Uint8Array;
}

export function createMouseStripper(): MouseStripper {
  let carry = new Uint8Array(0);
  return {
    push(chunk: Uint8Array): Uint8Array {
      const buf = new Uint8Array(carry.length + chunk.length);
      buf.set(carry, 0);
      buf.set(chunk, carry.length);
      carry = new Uint8Array(0);

      const out: number[] = [];
      let i = 0;
      let emitFrom = 0;
      const n = buf.length;

      while (i < n) {
        if (buf[i] !== 0x1b) { i++; continue; }
        // Truncated potential CSI at the buffer end (ESC, or ESC [ with the
        // third byte still to come): hold it — the test suite caught these
        // slipping through and getting emitted before the sequence completed.
        if (i + 1 >= n || (i + 2 >= n && buf[i + 1] === 0x5b /* [ */)) {
          out.push(...buf.slice(emitFrom, i));
          carry = buf.slice(i);
          return new Uint8Array(out);
        }
        // ESC [ ? <params> h|l
        if (buf[i + 1] !== 0x5b /* [ */ || buf[i + 2] !== 0x3f /* ? */) {
          i++;
          continue;
        }
        let j = i + 3;
        const paramStart = j;
        while (j < n && (isDigit(buf[j]) || buf[j] === 0x3b /* ; */)) j++;
        if (j >= n) {
          // Ran off the end inside a candidate sequence.
          const len = j - i;
          if (len <= MAX_CSI) {
            // Might be an incomplete mouse-enable: hold it for the next chunk.
            out.push(...buf.slice(emitFrom, i));
            carry = buf.slice(i);
            return new Uint8Array(out);
          }
          // Too long to be one of ours: skip the ESC and rescan.
          out.push(...buf.slice(emitFrom, i + 1));
          emitFrom = i + 1;
          i++;
          continue;
        }
        const cmd = buf[j]; // 0x68 'h' or 0x6c 'l'
        if (cmd !== 0x68 && cmd !== 0x6c) {
          i = j + 1;
          continue;
        }
        const params = decoder.decode(buf.slice(paramStart, j)).split(";");
        const mouseParams = params.filter((p) => MOUSE_MODES.has(p));
        if (cmd === 0x68 /* h */ && mouseParams.length > 0) {
          // Emit everything before the sequence.
          out.push(...buf.slice(emitFrom, i));
          const rest = params.filter((p) => !MOUSE_MODES.has(p));
          if (rest.length > 0) {
            // Compound CSI: re-emit the non-mouse params.
            out.push(...encoder.encode(`\x1b[?${rest.join(";")}h`));
          }
          emitFrom = j + 1;
        }
        i = j + 1;
      }
      out.push(...buf.slice(emitFrom));
      return new Uint8Array(out);
    },
  };
}
