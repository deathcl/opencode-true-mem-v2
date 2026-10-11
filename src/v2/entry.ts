/**
 * True-Mem V2 entry (OpenCode V2 plugin API).
 *
 * Strategy: reuse the entire V1 cognitive core by calling the existing
 * `createTrueMemoryPlugin()` factory with a *fabricated* V1 PluginInput whose
 * `client.session.messages()` is backed by the V2 `ctx.session.context()` API.
 * We then register V2 hooks/events that delegate to the returned V1 hooks,
 * translating input/output shapes in both directions.
 *
 * Exported as a plain object `{ id, setup }` — the V2 loader accepts this shape
 * directly, so there is no runtime dependency on @opencode/plugin.
 */

import type { PluginInput, Hooks } from '@opencode-ai/plugin';
import { createTrueMemoryPlugin, markChildSession } from '../adapters/opencode/index.js';
import { log } from '../logger.js';

// ---------------------------------------------------------------------------
// V2 message -> V1 message container conversion
// V1 core expects: { info: { role: 'user'|'assistant'|... }, parts: Part[] }
// V2 returns: { type: 'user'|'assistant'|..., text?, content?: [...] }
// ---------------------------------------------------------------------------

interface V1Part {
  type: string;
  text?: string;
  tool?: string;
  state?: { status?: string; output?: unknown; input?: unknown };
}

interface V1MessageContainer {
  info: { role: string; id?: string };
  parts: V1Part[];
}

function toV1Message(m: any): V1MessageContainer {
  if (m?.type === 'user') {
    return {
      info: { role: 'user', id: m.id },
      parts: [{ type: 'text', text: typeof m.text === 'string' ? m.text : '' }],
    };
  }

  if (m?.type === 'assistant') {
    const content: any[] = Array.isArray(m.content) ? m.content : [];
    const parts: V1Part[] = content.map((c: any) => {
      if (c?.type === 'text') return { type: 'text', text: c.text ?? '' };
      if (c?.type === 'reasoning') return { type: 'reasoning', text: c.text ?? '' };
      if (c?.type === 'tool') {
        const state = c.state ?? {};
        return {
          type: 'tool',
          tool: c.name ?? c.tool ?? c.id,
          state: {
            status: c.status ?? state.status ?? 'completed',
            output: c.output ?? state.output ?? '',
            input: c.input ?? state.input,
          },
        };
      }
      return { type: 'text', text: '' };
    });
    return { info: { role: 'assistant', id: m.id }, parts };
  }

  // system / synthetic / other: no textual content the extractor needs
  return { info: { role: typeof m?.type === 'string' ? m.type : 'system', id: m?.id }, parts: [] };
}

function toolResultText(event: any): string {
  try {
    if (event?.status === 'error') {
      return String(event?.error?.message ?? event?.error ?? '');
    }
    const r = event?.result;
    if (r == null) return '';
    if (typeof r === 'string') return r;
    if (Array.isArray(r.content)) {
      return r.content
        .map((c: any) => (typeof c === 'string' ? c : (c?.text ?? '')))
        .join('\n');
    }
    return JSON.stringify(r).slice(0, 2000);
  } catch {
    return '';
  }
}

function systemPartsToText(parts: any[]): string {
  if (!Array.isArray(parts)) return typeof parts === 'string' ? parts : '';
  return parts
    .map((p) => (typeof p === 'string' ? p : (p?.text ?? '')))
    .join('\n');
}

// ---------------------------------------------------------------------------
// V2 event -> V1 event forwarding
// ---------------------------------------------------------------------------

// Only these V2 events are relevant to the core. Everything else (streaming
// deltas, *.updated registries, mcp/shell/usage noise) is dropped to avoid
// flooding the core and the debug log.
const FORWARD_EVENTS = new Set<string>([
  'session.created',
  'session.idle',
  'session.deleted',
  'session.error',
  'message.updated',
  'session.status',
  // V2 does not emit a public "session.idle"; turn completion surfaces as
  // step/execution lifecycle events. Map these to the core's idle handler.
  'session.step.ended',
  'session.execution.succeeded',
]);

// OpenCode instantiates the plugin more than once per process, so the same V2
// event is delivered to several subscriptions. Dedupe by event id on globalThis
// (shared across module graphs in the same process) to collapse repeated work.
const SEEN_EVENTS_KEY = Symbol.for('true-mem.v2.seen-event-ids');

function isDuplicateEvent(id: unknown): boolean {
  if (typeof id !== 'string' || !id) return false;
  const g = globalThis as unknown as Record<symbol, Set<string>>;
  const seen = (g[SEEN_EVENTS_KEY] ??= new Set<string>());
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 8192) {
    let removed = 0;
    for (const v of seen) {
      seen.delete(v);
      if (++removed >= 4096) break;
    }
  }
  return false;
}

function forwardEvent(e: any, hooks: Hooks): void {
  const type = e?.type;
  if (!type || typeof type !== 'string' || !FORWARD_EVENTS.has(type)) return;
  if (isDuplicateEvent(e?.id)) return;

  const data = (e?.data ?? {}) as Record<string, unknown>;

  // Track V2 child sessions so the core can skip sub-agent extraction.
  if (type === 'session.created') {
    const sid = (data.sessionID ?? data.id) as string | undefined;
    if (data.parentID && sid) markChildSession(sid);
  }

  // Normalise "turn finished" signals to the core's `session.idle` handling.
  let v1Type = type;
  if (type === 'session.status') {
    if (data.status !== 'idle') return;
    v1Type = 'session.idle';
  } else if (type === 'session.step.ended' || type === 'session.execution.succeeded') {
    v1Type = 'session.idle';
  }

  const v1event = { type: v1Type, properties: { ...data, info: data } };
  if (hooks.event) {
    Promise.resolve(hooks.event({ event: v1event as any })).catch((err) =>
      log(`V2 event forward error (${v1Type}): ${err}`),
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default {
  id: 'true-mem',
  async setup(ctx: any): Promise<() => void> {
    log('V2 adapter: setup start');

    const directory: string | undefined =
      ctx?.location?.directory ?? ctx?.location?.project?.directory ?? undefined;

    // Fabricated V1 client backed by the V2 session API.
    const fakeClient: any = {
      session: {
        messages: async ({ path }: { path: { id: string } }) => {
          try {
            const msgs = await ctx.session.context({ sessionID: path.id });
            return { data: (msgs ?? []).map(toV1Message) };
          } catch (err) {
            log(`V2 session.context failed: ${err}`);
            return { error: err };
          }
        },
        // Dead code in the V1 core (commented-out lazy injection); stubbed.
        prompt: async () => ({ data: {} }),
      },
      tui: {
        // V2 has no plugin tui domain; toasts are cosmetic -> no-op.
        showToast: async () => {},
      },
    };

    const fakeCtx = {
      client: fakeClient,
      directory,
      worktree: directory,
    } as unknown as PluginInput;

    let hooks: Hooks;
    try {
      hooks = await createTrueMemoryPlugin(fakeCtx);
    } catch (err) {
      log(`V2 adapter: createTrueMemoryPlugin failed: ${err}`);
      throw err;
    }

    const registrations: Array<{ dispose: () => Promise<void> | void }> = [];

    // --- prompt hook  <-  V1 "chat.message" (memory-list meta command) ---
    if (hooks['chat.message']) {
      const reg = await ctx.session.hook('prompt', async (event: any) => {
        try {
          const output: any = { parts: [{ type: 'text', text: event.prompt?.text ?? '' }] };
          await hooks['chat.message']!(
            { sessionID: event.sessionID, messageID: event.messageID } as any,
            output,
          );
          const newText = (output.parts ?? [])
            .filter((p: any) => p?.type === 'text')
            .map((p: any) => p.text ?? '')
            .join('');
          if (typeof newText === 'string' && newText !== event.prompt.text) {
            event.prompt.text = newText;
          }
        } catch (err) {
          log(`V2 prompt hook error: ${err}`);
        }
      });
      registrations.push(reg);
    }

    // --- context hook  <-  V1 "experimental.chat.system.transform" ---
    if (hooks['experimental.chat.system.transform']) {
      const reg = await ctx.session.hook('context', async (event: any) => {
        try {
          const before = systemPartsToText(event.system);
          const output: any = { system: [before] };
          await hooks['experimental.chat.system.transform']!(
            { sessionID: event.sessionID, model: event.model } as any,
            output,
          );
          const after = Array.isArray(output.system)
            ? output.system.join('\n')
            : String(output.system ?? '');
          if (after && after.length > before.length && after.startsWith(before)) {
            event.system.push({ type: 'text', text: after.slice(before.length) });
          }
        } catch (err) {
          log(`V2 context hook error: ${err}`);
        }
      });
      registrations.push(reg);
    }

    // --- tool.execute.before  <-  V1 task/background_task sub-agent injection ---
    if (hooks['tool.execute.before']) {
      const reg = await ctx.tool.hook('execute.before', async (event: any) => {
        try {
          const output: any = { args: event.input };
          await hooks['tool.execute.before']!(
            { tool: event.tool, sessionID: event.sessionID, callID: event.id } as any,
            output,
          );
          if (output.args !== event.input) event.input = output.args;
        } catch (err) {
          log(`V2 tool.execute.before error: ${err}`);
        }
      });
      registrations.push(reg);
    }

    // --- tool.execute.after  <-  V1 post-tool-use bookkeeping ---
    if (hooks['tool.execute.after']) {
      const reg = await ctx.tool.hook('execute.after', async (event: any) => {
        try {
          const output: any = { title: '', output: toolResultText(event), metadata: {} };
          await hooks['tool.execute.after']!(
            { tool: event.tool, sessionID: event.sessionID, args: event.input } as any,
            output,
          );
        } catch (err) {
          log(`V2 tool.execute.after error: ${err}`);
        }
      });
      registrations.push(reg);
    }

    // NOTE: compaction injection is intentionally deferred for the first cut.
    // V1 replaces the compaction prompt; V2 expects a produced summary
    // (`event.result`). Leaving the normal model call untouched is safe; the
    // core's `injectOnCompaction` path stays inert until reimplemented.

    // --- event stream  <-  V1 "event" hook ---
    const controller = new AbortController();
    (async () => {
      try {
        for await (const e of ctx.event.subscribe({ signal: controller.signal })) {
          forwardEvent(e, hooks);
        }
      } catch (err) {
        if (!controller.signal.aborted) log(`V2 event stream error: ${err}`);
      }
    })();

    log('V2 adapter: setup complete');

    return () => {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
      for (const r of registrations) {
        try {
          void r.dispose();
        } catch {
          /* ignore */
        }
      }
    };
  },
};
