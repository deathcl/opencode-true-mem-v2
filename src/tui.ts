/**
 * True-Mem TUI plugin (OpenCode CLI/TUI surface).
 *
 * The server-side plugin has no toast API in V2, so it cannot notify on its
 * own. This TUI-side companion tails the true-mem debug log and shows a toast
 * whenever the core stores a memory ("Stored <type> memory in <LTM|STM> ...").
 *
 * The core can store several memories per turn, so notifications are COALESCED:
 * a short quiet window collapses a burst into a single toast ("N memories
 * saved"), and exact duplicates are dropped. One active poller per process.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, openSync, closeSync, fstatSync, readSync } from 'fs';

const LOG_FILE = join(homedir(), '.true-mem', 'plugin-debug.log');
const STORE_RE = /Stored\s+(\w+)\s+memory\s+in\s+(LTM|STM)\s+\(confidence:\s*([0-9.]+)/i;
const TOAST_MS = 8000;
const COALESCE_MS = 3000;

const ACTIVE_KEY = Symbol.for('true-mem.tui.active');
const SEEN_KEY = Symbol.for('true-mem.tui.seen-lines');

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
    const g = globalThis as unknown as Record<symbol, any>;

    // Single active poller per process (the host re-runs setup on reload).
    if (g[ACTIVE_KEY]) {
      try {
        g[ACTIVE_KEY].dispose?.();
      } catch {
        /* ignore */
      }
    }
    const seen: Set<string> = (g[SEEN_KEY] ??= new Set<string>());

    let offset = fileSize();
    let carry = '';

    // Coalescing buffer: distinct save descriptions accumulated for one burst.
    const pending: Set<string> = new Set();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const showToast = (title: string, message: string) => {
      try {
        context?.ui?.toast?.show?.({ title, message, variant: 'success', duration: TOAST_MS });
      } catch {
        /* ignore */
      }
      try {
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

    const flush = () => {
      flushTimer = null;
      if (pending.size === 0) return;
      const items = [...pending];
      pending.clear();
      if (items.length === 1) {
        showToast('🧠 Memory saved', items[0]);
      } else {
        showToast('🧠 Memory saved', `${items.length} memories saved`);
      }
    };

    const onStore = (description: string) => {
      pending.add(description);
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, COALESCE_MS);
    };

    const poll = () => {
      try {
        if (!existsSync(LOG_FILE)) return;
        const fd = openSync(LOG_FILE, 'r');
        try {
          const size = fstatSync(fd).size;
          if (size < offset) {
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
            if (!m) continue;
            const [, classification, store, confidence] = m;
            const description = `${classification} → ${store} (conf ${confidence})`;
            // Dedupe identical saves (ignore the log's timestamp prefix).
            const key = description;
            if (seen.has(key)) continue;
            seen.add(key);
            if (seen.size > 4096) {
              let removed = 0;
              for (const v of seen) {
                seen.delete(v);
                if (++removed >= 2048) break;
              }
            }
            onStore(description);
          }
        } finally {
          closeSync(fd);
        }
      } catch {
        /* best effort — never break the TUI */
      }
    };

    const timer = setInterval(poll, 2000);

    const dispose = () => {
      clearInterval(timer);
      if (flushTimer) clearTimeout(flushTimer);
      if (g[ACTIVE_KEY]?.dispose === dispose) delete g[ACTIVE_KEY];
    };
    g[ACTIVE_KEY] = { dispose };

    return dispose;
  },
};
