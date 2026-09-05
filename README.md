# bb-plugin-provider-muse

A native **bb** agent provider that bridges to **Meta's Muse Code** CLI (Muse
Spark 1.3). It launches `muse` and speaks the Muse Server Protocol (MSP)
through a bb Provider Bridge, so you can drive Muse models directly in bb
threads.

> Requires the [Muse Code](https://github.com) CLI on `PATH` (or pointed to
> via the `MUSE_CLI` env var) with an authenticated account
> (`~/.config/muse/auth.json`).

## What it provides

- Registers the `muse` provider with bb.
- **Workspace-rooted full toolset by default.** `muse serve` sessions are
  rooted in a per-thread workspace (`workspaceRoot` on `session/start`), so
  the full policy-gated toolset — shell, file write, web search, subagents —
  is available in the persistent serve session, exactly like running `muse`
  itself. Model picker: `muse:spark-1.3`.
- **exec** (`:tools`) remains available as an explicit alternative one-shot
  `muse exec` engine with `--session-id` continuity. Tool calls are surfaced
  as bb `toolCall` items for full in-thread visibility. Model picker:
  `muse:spark-1.3:tools`. Serve already provides the full toolset, so exec
  is not needed for tool access.

  Choose exec per thread from the model picker, or globally by setting
  `MUSE_ENGINE=exec`.

- **Cross-turn continuity** without token blowup: both engines keep the
  conversation in the Muse session (exec via `--session-id` persisted per
  thread, `.muse-session` in the thread workspace), so each turn sends only
  the new prompt rather than replaying full history.

## Install

```sh
npm install
bb plugin install .
```

After editing sources, reload:

```sh
bb plugin reload provider-muse
```

Or run `bb plugin dev` to rebuild and reload on every save.

## Usage

Spawn a thread with the Muse provider:

```sh
bb thread spawn --provider muse --model muse:spark-1.3 \   # serve (default, full tools)
bb thread spawn --provider muse --model muse:spark-1.3:tools \  # exec (alternative)
  --prompt "your task"
```

`bb` will launch the appropriate `muse` engine and bridge it into the
thread. Both engines keep the conversation in the Muse session; tool calls
(web search, file writes, shell, subagents) are shown as items in the
timeline.

## How it works

- `server.ts` — registers the provider and declares its capability facts.
- `host.ts` — exports `experimental_providerBridge`, the single `bb.host`
  artifact that bb drives in its own process.
- `src/provider-bridge.ts` — the bridge: launches `muse`, speaks MSP,
  implements the bb Provider Bridge Protocol (grammar v3), and maps Muse
  exec tool events to bb tool items.

## Caveats

- serve mode's toolset is gated by the workspace being rooted in
  `session/start`; the bridge passes the per-thread workspace so serve gets
  the full toolset. Without a rooted workspace, Muse serves only
  `write_todos` + `search`.
- `muse exec` must not be passed `--model`: bb's picker IDs are not valid
  in exec's model catalog, so the bridge omits the flag and lets Muse
  resolve its own default model.

## License

MIT
