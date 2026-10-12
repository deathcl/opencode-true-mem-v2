/**
 * True-Mem TUI plugin (OpenCode CLI/TUI surface).
 *
 * The server-side plugin has no toast API in V2, so it cannot notify on its
 * own. This TUI-side companion tails the true-mem debug log and shows a toast
 * whenever the core stores a memory ("Stored <type> memory in <LTM|STM> ...").
 *
 * The core can store several memories per turn, so notifications are COALESCED:
 * a short quiet window collapses a burst into a single toast ("N memories
 * saved"). Burst entries are keyed by the full log line: the core log line
 * carries no memory summary, so class/store/confidence alone would collapse two
 * DIFFERENT memories into one toast. One active poller per process.
 */

import { homedir } from 'os';
import { join } from 'path';
import { existsSync, openSync, closeSync, fstatSync, readSync } from 'fs';
import { createHash } from 'crypto';

const LOG_FILE = join(homedir(), '.true-mem', 'plugin-debug.log');
const STORE_RE = /Stored\s+(\w+)\s+memory\s+in\s+(LTM|STM)\s+\(confidence:\s*([0-9.]+)/i;
const TOAST_MS = 8000;
const COALESCE_MS = 3000;

const ACTIVE_KEY = Symbol.for('true-mem.tui.active');
const SEEN_KEY = Symbol.for('true-mem.tui.seen-lines');

/**
 * Stable key for one stored-memory log line.
 * The line has no memory summary, so the discriminator must be the line itself
 * (classification, store, confidence, role, reason + logger timestamp) - that
 * is the only thing that makes two saves in the same burst distinguishable.
 */
function lineKey(line: string): string {
  return createHash('sha1').update(line).digest('hex').slice(0, 16);
}

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
    // Diagnostics: prove whether this setup runs and what the host actually
    // provides. Silent optional-chaining hides everything otherwise.
    try {
      const fs2 = require('fs') as typeof import('fs');
      const line = `[${new Date().toISOString()}] setup | ui=${Object.keys(context?.ui ?? {}).join(',')} | attention=${!!context?.attention} | toast=${typeof context?.ui?.toast?.show}\n`;
      fs2.appendFileSync(LOG_FILE.replace('plugin-debug.log', 'tui-debug.log'), line);
    } catch {
      /* ignore */
    }
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

    // Coalescing buffer: distinct saves accumulated for one burst, keyed by log
    // line so two DIFFERENT memories with the same class/store/confidence still
    // count as two separate saves.
    const pending: Map<string, string> = new Map();
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const showToast = (title: string, message: string) => {
      try {
        const fs2 = require('fs') as typeof import('fs');
        fs2.appendFileSync(LOG_FILE.replace('plugin-debug.log', 'tui-debug.log'), `[${new Date().toISOString()}] showToast: ${title} | ${message}\n`);
      } catch {
        /* ignore */
      }
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
      const items = [...pending.values()];
      pending.clear();
      if (items.length === 1) {
        showToast('🧠 Memory saved', items[0]!);
      } else {
        showToast('🧠 Memory saved', `${items.length} memories saved`);
      }
    };

    const onStore = (key: string, description: string) => {
      pending.set(key, description);
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
            // Dedupe identical log lines (the core log line has no summary, so
            // the line itself is the discriminator); the timestamp prefix is
            // part of the line, hence two distinct saves never collide.
            const key = lineKey(line);
            if (seen.has(key)) continue;
            seen.add(key);
            if (seen.size > 4096) {
              let removed = 0;
              for (const v of seen) {
                seen.delete(v);
                if (++removed >= 2048) break;
              }
            }
            onStore(key, description);
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
