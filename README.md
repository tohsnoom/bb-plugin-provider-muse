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
- Two engines, selectable per thread:

  - **serve** (default) — a persistent `muse serve` session with a minimal
    toolset (`write_todos`, `search`). Low token overhead; ideal for chat.
    Model picker: `muse:spark-1.3`.
  - **exec** (`:tools`) — the full engine via `muse exec`: web search, file
    edit, shell, and subagent tools. Tool calls are surfaced as bb
    `toolCall` items for full in-thread visibility. Model picker:
    `muse:spark-1.3:tools`.

  Choose exec per thread from the model picker, or globally by setting
  `MUSE_ENGINE=exec`.

- **Cross-turn continuity** without token blowup: exec mode persists the
  Muse `--session-id` per thread (`.muse-session` in the thread's
  workspace), so each turn sends only the new prompt rather than replaying
  full history.

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
bb thread spawn --provider muse --model muse:spark-1.3 \   # serve (default)
bb thread spawn --provider muse --model muse:spark-1.3:tools \  # full tools
  --prompt "your task"
```

`bb` will launch the appropriate `muse` engine and bridge it into the
thread. Full-tools threads show each tool call (web search, file writes,
shell, subagents) as an item in the timeline.

## How it works

- `server.ts` — registers the provider and declares its capability facts.
- `host.ts` — exports `experimental_providerBridge`, the single `bb.host`
  artifact that bb drives in its own process.
- `src/provider-bridge.ts` — the bridge: launches `muse`, speaks MSP,
  implements the bb Provider Bridge Protocol (grammar v3), and maps Muse
  exec tool events to bb tool items.

## Caveats

- serve mode's toolset is fixed by the Muse platform to `write_todos` +
  `search`; the full toolset requires exec mode.
- `muse exec` must not be passed `--model`: bb's picker IDs are not valid
  in exec's model catalog, so the bridge omits the flag and lets Muse
  resolve its own default model.

## License

MIT
