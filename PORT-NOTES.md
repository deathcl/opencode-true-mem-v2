# PORT-NOTES — OpenCode V2 port

This is a community **V2 port** of [true-mem](https://github.com/rizal72/true-mem) by rizal72.
Upstream is V1-only and does not load on OpenCode V2 (the V2 plugin API is an intentional
breaking change: V2 plugins must `export default` an object with `id` + `setup`).

## What this fork changes (vs upstream)

- `src/v2/entry.ts` — **New.** V2 entry. Wraps the original core
  (`createTrueMemoryPlugin()` in `src/adapters/opencode/index.ts`) with a fabricated V1 client backed by
  the V2 `ctx.session.context()` API, and translates hook/event shapes:
  - `chat.message` → `session.hook("prompt")`
  - `experimental.chat.system.transform` → `session.hook("context")`
  - `tool.execute.before/after` → `tool.hook("execute.before"/"execute.after")`
  - `client.session.messages` → `ctx.session.context()`
  - V2 lifecycle events → the core's `session.idle` extraction trigger
  - dedupe of duplicate event delivery across plugin instances
- `src/tui.ts` — **New.** TUI companion (exposed as `./tui`). The V2 server plugin API has no toast
  surface, so this tails `~/.true-mem/plugin-debug.log` and shows a toast (`context.ui.toast.show`)
  when a memory is stored. Bursts are coalesced into one toast.
- `src/adapters/opencode/index.ts` — small patch: child-session registry for V2 sub-agent detection
  (V2 has no `-task-` session-id convention).
- `package.json` — entry repointed to the V2 build; adds the `./tui` export.

The **cognitive core is untouched** (classifier, patterns, decay, STM/LTM, SQLite, optional embeddings).

## Install (local, without publishing)

1. Build: `bun install && bun run build`.
2. Server plugin: expose the built entry to OpenCode, e.g. a bridge dir
   `~/.config/opencode/plugins/<name>/index.ts` containing
   `export { default } from "<abs-path>/dist/entry.js";`.
3. TUI companion: add that bridge dir (as a package exposing `./tui`) to `cli.json`:
   `{ "plugins": ["<absolute path to bridge dir>"] }`.

## Known limitations / differences from upstream

- **Compaction injection** (`experimental.session.compacting`) is **not ported**. V1 replaced the
  compaction *prompt*; V2's `compaction` hook expects a produced *summary*. With the default
  `injectionMode: 1` (inject every prompt) memories re-enter the system prompt anyway, so the impact is
  limited.
- The core can store **several memories per turn** (including tentative STM entries), and identical
  stores are merged by reconsolidation (no duplicate rows). The TUI toast coalesces these into one.
- **Per-pass dedupe:** identical user text within a single extraction pass is de-duplicated, so a
  legitimately repeated instruction inside one window may be stored once.
- **Extraction runs for all top-level sessions** (upstream behavior).
- Optional NLP embeddings remain off by default (Jaccard similarity).

## Publishing

Before pushing/publishing: review `package.json` (`private: true` is set to prevent accidental
`npm publish`; rename if needed), the git author identity, and remove/keep CI as desired.
This fork is not affiliated with the upstream author.

## License

MIT — see [LICENSE](./LICENSE). Original © rizal72. V2 port © its contributors.
