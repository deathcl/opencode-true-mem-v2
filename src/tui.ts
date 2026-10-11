/**
 * True-Mem TUI plugin (OpenCode CLI/TUI surface).
 *
 * The server-side plugin has no toast API in V2, so it cannot notify on its
 * own. This TUI-side companion tails the true-mem debug log and shows a toast
 * whenever the core stores a memory ("Stored <type> memory in <LTM|STM> ...").
 *
 * Also fires an OS notification + sound via `attention.notify` when the user
 * has attention enabled (skipped otherwise).
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, openSync, closeSync, fstatSync, readSync } from 'fs';

const LOG_FILE = join(homedir(), '.true-mem', 'plugin-debug.log');
const STORE_RE = /Stored\s+(\w+)\s+memory\s+in\s+(LTM|STM)\s+\(confidence:\s*([0-9.]+)/i;
const TOAST_MS = 8000;

function fileSize(): number {
  if (!existsSync(LOG_FILE)) return 0;
  let fd: number | undefined;
  try {
    fd = openSync(LOG_FILE, 'r');
    return fstatSync(fd).size;
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export default {
  id: 'true-mem-tui',
  setup(context: any): () => void {
    // Start from the current end of file so we only notify on NEW saves.
    let offset = fileSize();
    let carry = '';

    const notify = (title: string, message: string) => {
      try {
        context?.ui?.toast?.show?.({ title, message, variant: 'success', duration: TOAST_MS });
      } catch {
        /* ignore */
      }
      try {
        // Best effort; skipped when the user has attention disabled.
        void context?.attention?.notify?.({
          title,
          message,
          notification: { when: 'always' },
          sound: { name: 'done', volume: 0.6, when: 'always' },
        });
      } catch {
        /* ignore */
      }
    };

    const poll = () => {
      try {
        if (!existsSync(LOG_FILE)) return;
        const fd = openSync(LOG_FILE, 'r');
        try {
          const size = fstatSync(fd).size;
          if (size < offset) {
            // Log rotated/truncated — restart from the beginning.
            offset = 0;
            carry = '';
          }
          if (size === offset) return;

          const len = size - offset;
          const buf = Buffer.alloc(len);
          readSync(fd, buf, 0, len, offset);
          offset = size;

          const text = carry + buf.toString('utf-8');
          const lines = text.split('\n');
          carry = lines.pop() ?? '';

          for (const line of lines) {
            const m = line.match(STORE_RE);
            if (m) {
              const [, classification, store, confidence] = m;
              notify('🧠 Memory saved', `${classification} → ${store} (conf ${confidence})`);
            }
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        /* best effort — never break the TUI */
      }
    };

    const timer = setInterval(poll, 2000);
    return () => clearInterval(timer);
  },
};
