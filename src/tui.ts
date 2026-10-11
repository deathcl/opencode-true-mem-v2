/**
 * True-Mem TUI plugin (OpenCode CLI/TUI surface).
 *
 * The server-side plugin has no toast API in V2, so it cannot notify on its
 * own. This TUI-side companion tails the true-mem debug log and shows a toast
 * whenever the core stores a memory ("Stored <type> memory in <LTM|STM> ...").
 *
 * Exported as a plain object `{ id, setup }` (no runtime dependency on
 * @opencode/plugin/tui) so it stays trivially bundleable.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, openSync, closeSync, fstatSync, readSync, appendFileSync } from 'fs';

const LOG_FILE = join(homedir(), '.true-mem', 'plugin-debug.log');
const STORE_RE = /Stored\s+(\w+)\s+memory\s+in\s+(LTM|STM)\s+\(confidence:\s*([0-9.]+)/i;

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
    // Start from the current end of file so we only toast NEW saves.
    let offset = fileSize();
    let carry = ''; // partial line buffer across reads

    // Load marker: proves the TUI host actually ran this plugin (helps verify
    // the CLI/TUI surface without needing to see a toast).
    try {
      appendFileSync(join(homedir(), '.true-mem', 'tui-plugin.log'), `${new Date().toISOString()} setup (pid ${process.pid})\n`);
    } catch {
      /* ignore */
    }

    const toast = (title: string, message: string, variant = 'success') => {
      try {
        context?.ui?.toast?.show?.({ title, message, variant, duration: 4000 });
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
            // Log rotated/truncated — restart from the beginning of the new file.
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
              toast('🧠 Memory saved', `${classification} → ${store} (conf ${confidence})`);
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
