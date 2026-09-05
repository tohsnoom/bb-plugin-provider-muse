/**
 * Muse Code provider bridge: the smallest correct implementation of bb's
 * Provider Bridge Protocol that launches Meta's `muse serve` and speaks the
 * Muse Server Protocol (MSP) to it over stdio.
 *
 * Transport for BOTH legs is line-delimited JSON-RPC 2.0:
 *   - bb ↔ bridge: on our own stdin/stdout (the daemon's bridge bootstrap).
 *   - bridge ↔ muse: on the child process's stdin/stdout (MSP methods
 *     model/list, session/start, turn/start, ...; notifications
 *     item/delta, item/completed, turn/completed, ...).
 *
 * We are the JSON-RPC *client* to muse (requests carry an id; we match
 * responses back to pending calls) and the JSON-RPC *server* to bb. Muse's
 * streaming assistant output arrives as `item/*` notifications, which we
 * translate into bb `thread/delta` item deltas.
 */
import {
  type ClientTurnRequestId,
  type PromptInput,
  type ThreadDelta,
  BRIDGE_JSON_RPC_ERRORS,
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  THREAD_DELTA_GRAMMAR_V3,
  THREAD_DELTA_NOTIFICATION_METHOD,
  initializeParamsSchema,
  modelListParamsSchema,
  threadResumeParamsSchema,
  threadStartParamsSchema,
  threadStopParamsSchema,
  turnStartParamsSchema,
  turnSteerParamsSchema,
  experimental_defineProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  spawnMspConnection,
  type SpawnedMspConnection,
} from "@muse-code/sdk";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  sessionWorkspaceFor,
  museCommand,
  resolveEngine,
  resolveMuseBin,
} from "./engine.js";

// ---------------------------------------------------------------------------
// bb → bridge: line-delimited JSON-RPC 2.0 on our stdout (protocol traffic
// only, never stray logs).
// ---------------------------------------------------------------------------

const instanceNonce = randomUUID().replaceAll("-", "").slice(0, 12);
let threadCounter = 0;
let nextRequestSeq = 0;

const LOG_PATH = "/tmp/muse-bridge.log";
function dbg(msg: string): void {
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* ignore */
  }
}

type JsonRpcId = string | number;

function writeMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}
function respondResult(id: JsonRpcId, result: unknown): void {
  writeMessage({ id, result });
}
function respondError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): void {
  writeMessage({ id, error: { code, message, ...(data !== undefined ? { data } : {}) } });
}
function notify(method: string, params: Record<string, unknown>): void {
  writeMessage({ method, params });
}
function emitDeltas(threadId: string, deltas: ThreadDelta[]): void {
  dbg(`emit thread=${threadId} kinds=${deltas.map((d) => d.kind).join(",")}`);
  notify(THREAD_DELTA_NOTIFICATION_METHOD, { threadId, deltas });
}

// ---------------------------------------------------------------------------
// bridge → muse: a small JSON-RPC client over the child's stdio.
// ---------------------------------------------------------------------------

let sp: SpawnedMspConnection | null = null;
let museReady = false;
let museError = "";

// ---------------------------------------------------------------------------
// Engine selection lives in engine.ts (pure, dependency-free, unit-testable).
// Default is `serve`; choose `exec` either globally via MUSE_ENGINE=exec or
// per-thread by picking the ":tools" model variant in the model picker.
// ---------------------------------------------------------------------------

/** Launch `muse serve` and complete the MSP handshake (initialize step included).
 *  This is the exact sequence the official SDK performs; Muse refuses every
 *  command until it has run. */
async function startMuse(): Promise<void> {
  if (museReady || sp) return;
  const { cmd, args } = museCommand();
  try {
    const handshake = spawnMspConnection({
      command: cmd,
      args,
      cwd: process.env.MUSE_CWD ?? process.cwd(),
      env: process.env,
      onStderr: (chunk) => {
        if (process.env.MUSE_BRIDGE_DEBUG) process.stderr.write(`[muse stderr] ${chunk}`);
      },
    });
    handshake.onNotification((n: { method: string; params?: Record<string, unknown> }) => {
      handleMuseNotification(n.method, (n.params ?? {}) as Record<string, unknown>);
    });
    handshake.onProtocolError((e) => {
      if (process.env.MUSE_BRIDGE_DEBUG) process.stderr.write(`[muse protocol] ${e.message}\n`);
    });
    sp = await handshake.initialize({
      clientInfo: { name: "bb", version: "0.1.0" },
      capabilities: { requestedCapabilities: ["userShell"] },
    });
    dbg("startMuse: MSP initialized OK; muse=" + sp.initializeResult.serverInfo.name + "@" + sp.initializeResult.serverInfo.version + "; granted=" + JSON.stringify((sp.initializeResult as { grantedCapabilities?: string[] }).grantedCapabilities ?? []));
    void sp.exited
      .then(() => {
        museReady = false;
      })
      .catch(() => {
        museReady = false;
      });
    museReady = true;
    museError = "";
  } catch (e) {
    museError = e instanceof Error ? e.message : String(e);
    museReady = false;
    dbg("startMuse: FAILED " + museError);
    if (process.env.MUSE_BRIDGE_DEBUG) process.stderr.write(`[muse] start failed: ${museError}\n`);
  }
}

let museReadyPromise: Promise<boolean> | null = null;

/** Returns true if muse is unavailable (caller should throw). Kicks off the
 *  boot once and waits for it so turns never race the handshake. */
function ensureMuse(): Promise<boolean> {
  if (museReady && sp) return Promise.resolve(false);
  if (!museReadyPromise) {
    const boot = startMuse();
    museReadyPromise = boot.then(() => (museReady ? false : true));
    void museReadyPromise;
  }
  return museReadyPromise;
}

async function museCall(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (await ensureMuse()) throw new Error(`muse not available: ${museError || "not started"}`);
  try {
    return await sp!.connection.request(method, params);
  } catch (e) {
    throw new Error(`muse ${method} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function museSend(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (await ensureMuse()) throw new Error(`muse not available: ${museError || "not started"}`);
  try {
    return await sp!.connection.command(method, params);
  } catch (e) {
    throw new Error(`muse ${method} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function museNotify(method: string, params: Record<string, unknown>): void {
  if (!sp || !museReady) return;
  sp.connection.notify(method, params);
}

function museMintCommandId(): string {
  if (!sp) return "";
  return sp.connection.mintCommandId();
}

// ---------------------------------------------------------------------------
// Session + turn state.
// ---------------------------------------------------------------------------

interface OpenChannel {
  itemId: string;
  lastText: string;
}
interface SessionState {
  providerThreadId: string;
  sessionId: string | null;
  activeTurn: string | null; // muse commandId of the in-flight turn
  channels: Map<string, OpenChannel>;
  // exec engine only:
  execSessionId: string | null; // persistent muse --session-id for per-thread continuity
  execWorkspace: string | null; // per-thread workspace dir (file state persists across turns)
  execChild: ChildProcess | null; // in-flight muse exec child
  // Open tool-call items surfaced from exec event stream, keyed by muse task_id.
  // Lets us open a bb `tool` item when Muse runs a tool and close it when the
  // result lands (tool.result carries the matching call_id, mapped via task_id).
  execToolTasks: Map<string, ExecToolTask>;
  // Map from muse tool call_id -> task_id, to correlate tool.result back to the
  // open tool item (task call id is only present on the intent event).
  execCallToTask: Map<string, string>;
}

interface ExecToolTask {
  itemId: string;
  toolName: string;
  callId: string | null;
  output: string;
}

const sessions = new Map<string, SessionState>();

function promptText(input: readonly PromptInput[]): string {
  return input
    .filter((item): item is Extract<PromptInput, { type: "text" }> => item.type === "text")
    .map((item) => item.text)
    .join("");
}

function openSession(threadId: string, providerThreadId: string, sessionId: string | null): void {
  sessions.set(threadId, {
    providerThreadId,
    sessionId,
    activeTurn: null,
    channels: new Map(),
    execSessionId: null,
    execWorkspace: null,
    execChild: null,
    execToolTasks: new Map(),
    execCallToTask: new Map(),
  });
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, { threadId, providerThreadId });
  emitDeltas(threadId, [{ kind: "session.reset" }]);
}

// --- item (agent message) streaming with the v3 item grammar ---

function openAgentItem(threadId: string, s: SessionState, itemId: string, initialText: string): void {
  emitDeltas(threadId, [
    {
      kind: "item.open",
      item: { type: "agentMessage", text: initialText },
      key: { channel: "agentMessage", providerItemId: itemId },
    },
  ]);
}
function agentTextDelta(threadId: string, s: SessionState, itemId: string, text: string): void {
  emitDeltas(threadId, [
    {
      kind: "item.textDelta",
      channel: "agentMessage",
      key: { providerItemId: itemId },
      text,
    },
  ]);
}
function agentTextClose(threadId: string, s: SessionState, itemId: string, text: string): void {
  emitDeltas(threadId, [
    {
      kind: "item.textClose",
      channel: "agentMessage",
      key: { providerItemId: itemId },
      text,
    },
  ]);
}

// --- tool-call items (exec engine only) ---
// The exec event stream announces a tool call via `task.lifecycle.side_effect_intent`
// with `event.operation: "tool:<name>"`. We open a bb `tool` item for it so tool
// usage is visible in the thread (same as other providers), then close it when the
// matching `tool.result` arrives. `tool` items carry args/result verbatim so tool
// activity appears in the timeline rather than only in the final answer.

const TOOL_RESULT_TRUNCATE = 4000; // keep transcript lean; tool payloads can be large

function toolPresentation(toolName: string) {
  return {
    label: {
      pending: `Running ${toolName}…`,
      completed: `Used ${toolName}`,
    },
    icon: { glyph: "tool" },
  };
}

function openToolItem(
  threadId: string,
  s: SessionState,
  taskId: string,
  toolName: string,
  callId: string | null,
): void {
  if (s.execToolTasks.has(taskId)) return;
  const itemId = randomUUID();
  s.execToolTasks.set(taskId, { itemId, toolName, callId, output: "" });
  emitDeltas(threadId, [
    {
      kind: "item.open",
      key: { channel: "tool", providerItemId: itemId },
      item: { type: "tool", tool: toolName },
      presentation: toolPresentation(toolName),
    },
  ]);
}

function closeToolItem(
  threadId: string,
  s: SessionState,
  taskId: string,
  status: "completed" | "failed",
  result: string,
  error?: string,
): void {
  const t = s.execToolTasks.get(taskId);
  if (!t) return;
  s.execToolTasks.delete(taskId);
  const item = error
    ? { type: "tool" as const, tool: t.toolName, error, result: result || undefined }
    : { type: "tool" as const, tool: t.toolName, result: result || undefined };
  emitDeltas(threadId, [
    {
      kind: "item.close",
      key: { channel: "tool", providerItemId: t.itemId },
      status,
      item,
      presentation: toolPresentation(t.toolName),
    },
  ]);
}

function closeTurn(threadId: string, status: "completed" | "failed" | "interrupted"): void {
  const s = sessions.get(threadId);
  if (!s) return;
  const deltas: ThreadDelta[] = [];
  for (const ch of s.channels.values()) {
    agentTextClose(threadId, s, ch.itemId, ch.lastText);
  }
  s.channels.clear();
  s.activeTurn = null;
  deltas.push({ kind: "turn.boundary", status });
  emitDeltas(threadId, deltas);
}

// ---------------------------------------------------------------------------
// MSP (server → client) notifications → bb thread/delta.
// ---------------------------------------------------------------------------

function extractItemText(item: unknown): string {
  if (!item || typeof item !== "object") return "";
  const it = item as Record<string, unknown>;
  const parts = Array.isArray(it.parts) ? it.parts : Array.isArray(it.content) ? it.content : [];
  if (parts.length > 0) {
    return parts
      .map((p) => {
        if (!p || typeof p !== "object") return "";
        const part = p as Record<string, unknown>;
        return typeof part.text === "string" ? part.text : "";
      })
      .join("");
  }
  return typeof it.text === "string" ? it.text : "";
}

function isAssistantItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const it = item as Record<string, unknown>;
  const kind = it.kind ?? it.type ?? it.role;
  // Muse's item discriminator is `kind` — an assistant-generated message is an
  // `agentMessage` (a user turn is a `userMessage`). Everything model-authored
  // except the raw user echo is streamed as agent output.
  if (kind === "userMessage") return false;
  return kind === "agentMessage" || (typeof kind === "string" && kind.includes("Message"));
}

function findSessionForMuse(sessionId: string | null): { threadId: string; state: SessionState } | null {
  for (const [threadId, state] of sessions) {
    if (state.sessionId === sessionId || (sessionId === null && state.sessionId === null)) {
      return { threadId, state };
    }
  }
  return null;
}

function handleMuseNotification(method: string, params: Record<string, unknown>): void {
  const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
  const item =
    params.item && typeof params.item === "object"
      ? (params.item as Record<string, unknown>)
      : null;
  // item/started + item/completed carry the id on params.item.itemId; item/delta
  // (and some other variants) carry it top-level as params.itemId.
  const itemId =
    item && typeof item.itemId === "string"
      ? item.itemId
      : typeof params.itemId === "string"
        ? params.itemId
        : null;
  dbg(`muse-notif method=${method} session=${sessionId} item=${itemId}`);

  if (method === "turn/completed") {
    const hit = sessionId !== null ? findSessionForMuse(sessionId) : null;
    if (hit) {
      const terminal = params.terminal;
      const status =
        terminal === "completed"
          ? "completed"
          : terminal === "interrupted" || terminal === "cancelled"
            ? "interrupted"
            : "failed";
      closeTurn(hit.threadId, status);
    }
    return;
  }
  if (method === "turn/retracted" || method === "turn/started" || method === "session/*Changed" || method === "view/*") {
    return;
  }

  if (!itemId) return;
  const hit = sessionId !== null ? findSessionForMuse(sessionId) : null;
  const state = hit?.state;

  if (method === "item/started") {
    const item = params.item;
    if (itemId && isAssistantItem(item) && hit) {
      if (!state?.channels.has(itemId)) {
        state?.channels.set(itemId, { itemId, lastText: "" });
      }
      const text = extractItemText(item);
      if (text && state) {
        state.channels.get(itemId)!.lastText = text;
        openAgentItem(hit.threadId, state, itemId, text);
      } else if (hit) {
        openAgentItem(hit.threadId, state!, itemId, "");
      }
    }
    return;
  }

  if (method === "item/delta") {
    if (!state || !hit) return;
    const ch = state.channels.get(itemId);
    if (!ch) return;
    dbg("idelta raw=" + JSON.stringify(params).slice(0, 400));
    const delta = params.delta;
    const field = params.field;
    if (typeof delta === "string" && (field === "text" || field === undefined)) {
      ch.lastText += delta;
      agentTextDelta(hit.threadId, state, itemId, delta);
    }
    return;
  }

  if (method === "item/completed") {
    if (!state || !hit) return;
    const ch = state.channels.get(itemId);
    if (!ch) return;
    const text = extractItemText(params.item);
    if (text) ch.lastText = text;
    agentTextClose(hit.threadId, state, itemId, text || ch.lastText);
    state.channels.delete(itemId);
    return;
  }
}

// ---------------------------------------------------------------------------
// bb request handlers (keyed by the protocol vocabulary).
// ---------------------------------------------------------------------------

type RequestHandler = (id: JsonRpcId, params: unknown) => void;

function invalidParams(id: JsonRpcId, method: string, issues: unknown): void {
  respondError(id, BRIDGE_JSON_RPC_ERRORS.INVALID_PARAMS, `Invalid params for ${method}`, issues);
}

async function runMuseTurn(args: {
  threadId: string;
  sessionId: string | null;
  input: readonly PromptInput[];
  clientRequestId?: ClientTurnRequestId;
}): Promise<void> {
  const s = sessions.get(args.threadId);
  if (!s) return;
  const deltas: ThreadDelta[] = [];
  if (args.clientRequestId !== undefined) {
    deltas.push({ kind: "input.accepted", clientRequestId: args.clientRequestId });
  }
  deltas.push({ kind: "turn.open" });
  emitDeltas(args.threadId, deltas);

  const text = promptText(args.input);
  const commandId = museMintCommandId();
  s.activeTurn = commandId;
  try {
    await museSend("turn/start", {
      commandId,
      sessionId: args.sessionId ?? s.providerThreadId,
      schema: "server",
      input: [{ type: "text", text, displayText: text }],
      ifBusy: "queue",
    });
  } catch (e) {
    closeTurn(args.threadId, "failed");
  }
}

function extractModelId(params: unknown): string | undefined {
  if (params && typeof params === "object") {
    const p = params as { model?: { id?: string } };
    if (p.model && typeof p.model.id === "string") return p.model.id;
  }
  return undefined;
}

/** Read the model the user picked for this thread. bb passes it in
 *  `options.model` (a string) on turn/start (and via passthrough params). */
function turnModel(params: unknown): string | undefined {
  if (params && typeof params === "object") {
    const p = params as { options?: { model?: unknown }; model?: { id?: unknown } };
    if (typeof p.options?.model === "string") return p.options.model;
    if (typeof p.model?.id === "string") return p.model.id;
  }
  return undefined;
}

/** Exec engine: run `muse exec` headless with the full interactive toolset
 *  (web search, file edit, shell, subagents). Per-thread continuity comes
 *  from persisting a single `--session-id` (verified: Muse carries the
 *  conversation across runs with the same id) plus a per-thread workspace
 *  dir for file state. One-shot per turn — no steer support. */
async function runExecTurn(args: {
  threadId: string;
  input: readonly PromptInput[];
  clientRequestId?: ClientTurnRequestId;
  model?: string;
}): Promise<void> {
  const s = sessions.get(args.threadId);
  if (!s) return;
  const deltas: ThreadDelta[] = [];
  if (args.clientRequestId !== undefined) {
    deltas.push({ kind: "input.accepted", clientRequestId: args.clientRequestId });
  }
  deltas.push({ kind: "turn.open" });
  emitDeltas(args.threadId, deltas);

  const text = promptText(args.input).trim();
  if (!text) {
    closeTurn(args.threadId, "failed");
    return;
  }

  if (!s.execWorkspace) s.execWorkspace = sessionWorkspaceFor(args.threadId);
  mkdirSync(s.execWorkspace, { recursive: true });
  // Persist the muse session id in the workspace dir so thread resume keeps
  // conversation continuity (runExecTurn may be called again after resume).
  const sidFile = join(s.execWorkspace, ".muse-session");
  if (!s.execSessionId) {
    let sid: string | null = null;
    try {
      sid = existsSync(sidFile) ? readFileSync(sidFile, "utf8").trim() || null : null;
    } catch {
      sid = null;
    }
    s.execSessionId = sid ?? randomUUID();
    try {
      writeFileSync(sidFile, s.execSessionId, "utf8");
    } catch {
      /* best effort */
    }
  }

  const itemId = randomUUID();
  openAgentItem(args.threadId, s, itemId, "");

  // Write the prompt to a file (avoids argv-length limits on long messages).
  const promptFile = join(s.execWorkspace, `.muse-prompt-${Date.now()}.txt`);
  writeFileSync(promptFile, text, "utf8");

  // NOTE: do NOT pass --model to `muse exec`. The BB picker id (muse:spark-1.3)
  // is not a valid exec catalog id; forcing it makes the model stream fail
  // immediately ("run ended with Failed", exit 1). Omitting it lets exec resolve
  // its default model (falling back to muse-spark-1.3-contributor) correctly.
  const base = [
    "exec",
    "--yolo",
    "--workspace",
    s.execWorkspace,
    "--session-id",
    s.execSessionId,
    "--json",
    "--prompt-file",
    promptFile,
  ];

  const child = spawn(resolveMuseBin(), base, {
    cwd: s.execWorkspace,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  s.execChild = child;
  dbg("runExecTurn: spawned muse exec pid=" + child.pid + " session=" + s.execSessionId);

  let finalText = "";
  let settled = false;
  const settle = (status: "completed" | "failed") => {
    if (settled) return;
    settled = true;
    if (s.execChild === child) s.execChild = null;
    agentTextClose(args.threadId, s, itemId, finalText || "(muse returned no text)");
    closeTurn(args.threadId, status);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev: Record<string, any>;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const pt = ev?.payload_type as string | undefined;
      if (pt === "run.output.delta") {
        const t = ev?.payload?.text;
        if (typeof t === "string" && t) {
          finalText += t;
          agentTextDelta(args.threadId, s, itemId, t);
        }
      } else if (pt === "task.lifecycle.side_effect_intent") {
        const op = ev?.payload?.event?.operation as string | undefined;
        if (typeof op === "string" && op.startsWith("tool:")) {
          const toolName = op.slice("tool:".length);
          const taskId = ev?.payload?.task_id as string | undefined;
          // idempotency_key is "tool:call_<id>" for tool intents — recover call_id
          // so the later tool.result can be matched back to this task.
          const ik = ev?.payload?.event?.idempotency_key as string | undefined;
          let callId: string | null = null;
          if (typeof ik === "string" && ik.startsWith("tool:")) {
            callId = ik.slice("tool:".length);
            s.execCallToTask.set(callId, taskId ?? "");
          }
          if (taskId) openToolItem(args.threadId, s, taskId, toolName, callId);
        }
      } else if (pt === "task.lifecycle.output") {
        const chunk = ev?.payload?.event?.chunk;
        if (typeof chunk === "string" && chunk) {
          const taskId = ev?.payload?.task_id as string | undefined;
          const t = taskId ? s.execToolTasks.get(taskId) : undefined;
          if (t) {
            t.output = (t.output + chunk).slice(-TOOL_RESULT_TRUNCATE);
          }
        }
      } else if (pt === "tool.result") {
        const callId = ev?.payload?.call_id as string | undefined;
        const outcome = ev?.payload?.correlation_facts?.outcome as string | undefined;
        const text = ev?.payload?.text as string | undefined;
        const taskId = callId ? s.execCallToTask.get(callId) : undefined;
        if (taskId) {
          const t = s.execToolTasks.get(taskId);
          const body = typeof text === "string" && text ? text : t?.output ?? "";
          closeToolItem(
            args.threadId,
            s,
            taskId,
            outcome === "success" ? "completed" : "failed",
            body.slice(0, TOOL_RESULT_TRUNCATE),
            outcome === "success" ? undefined : `tool ${t?.toolName ?? "call"} ${outcome ?? "failed"}`,
          );
          if (callId) s.execCallToTask.delete(callId);
        }
      } else if (pt === "run.terminal.completed") {
        const t = ev?.payload?.text;
        if (typeof t === "string") finalText = t;
        settle("completed");
      } else if (pt === "run.terminal.rejected" || pt === "run.terminal.failed") {
        finalText = ev?.payload?.reason ?? ev?.payload?.message ?? "turn failed";
        settle("failed");
      }
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (process.env.MUSE_BRIDGE_DEBUG) process.stderr.write(`[muse exec] ${chunk}`);
  });
  child.on("error", (e) => {
    dbg("runExecTurn: spawn error " + e.message);
    finalText = "muse exec failed to start: " + e.message;
    settle("failed");
  });
  child.on("close", (code) => {
    if (!settled) settle(code === 0 ? "completed" : "failed");
  });
}

const handlers: Record<string, RequestHandler> = {
  [BRIDGE_REQUEST_METHODS.initialize]: (id, params) => {
    const parsed = initializeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.initialize, parsed.error.issues);
      return;
    }
    respondResult(id, {
      protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
      capabilities: {
        // This BB runtime assembles thread/delta grammar v3 only. We speak v3
        // (item.open/item.textDelta/item.textClose), so advertise exactly v3.
        grammarVersions: [THREAD_DELTA_GRAMMAR_V3, THREAD_DELTA_GRAMMAR_V3],
      },
    });
  },

  [BRIDGE_REQUEST_METHODS.modelList]: (id, params) => {
    const parsed = modelListParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.modelList, parsed.error.issues);
      return;
    }
    // The model picker reads this response, so return the live model catalog
    // entry rather than an empty array (an empty result overrides the manifest
    // fallback and leaves the provider with no selectable models).
    respondResult(id, {
      models: [
        {
          id: "muse:spark-1.3",
          model: "muse:spark-1.3",
          displayName: "Muse Spark 1.3",
          description:
            "Meta's flagship reasoning coding model via Muse Code — workspace-rooted persistent session with full tools (shell, file write, web, subagents).",
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "medium",
              description: "Balanced reasoning (Muse default)",
            },
          ],
        },
        {
          id: "muse:spark-1.3:tools",
          model: "muse:spark-1.3",
          displayName: "Muse Spark 1.3 (exec engine)",
          description:
            "Alternative `muse exec` one-shot engine (web search, file edit, shell, subagents) with --session-id continuity. Serve already carries full tools; this is an explicit alternative.",
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "medium",
              description: "Balanced reasoning (Muse default)",
            },
          ],
        },
      ],
      selectedOnlyModels: [],
    });
  },

  [BRIDGE_REQUEST_METHODS.threadStart]: (id, params) => {
    const parsed = threadStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStart, parsed.error.issues);
      return;
    }
    threadCounter += 1;
    const providerThreadId = `muse_${instanceNonce}_${threadCounter}`;

    // bb may send turn/start immediately after it receives this response, so we
    // must have the muse session created AND opened before responding —
    // otherwise turn/start races ahead and sees "No open session".
    void (async () => {
      const model = turnModel(parsed.data);
      if (resolveEngine(model) === "exec") {
        // exec engine: no serve session needed; workspace + session-id are
        // created lazily on the first exec turn for continuity.
        openSession(parsed.data.threadId, providerThreadId, null);
        respondResult(id, { providerThreadId });
        if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
          await runExecTurn({ threadId: parsed.data.threadId, input: parsed.data.input, model });
        }
        return;
      }
      let sessionId: string | null = null;
      try {
        // Root the serve session's workspace: without `workspaceRoot` on
        // session/start, muse serve advertises only its minimal built-in toolset
        // (write_todos, search). Passing the per-thread workspace dir grants the
        // full policy-gated toolset — shell, file write, web, subagents — making
        // serve behave like `muse` itself (verified live: with workspaceRoot the
        // model ran bash + write_file and landed probe_out.txt on disk). The same
        // dir exec uses (sessionWorkspaceFor), so both engines share the surface.
        const wsRoot = sessionWorkspaceFor(parsed.data.threadId);
        try {
          mkdirSync(wsRoot, { recursive: true });
        } catch {
          /* best-effort; a missing dir just yields the minimal toolset */
        }
        const startRes = (await museSend("session/start", {
          commandId: museMintCommandId(),
          approvalMode: "allowAll",
          workspaceRoot: wsRoot,
        })) as { session?: { sessionId?: string } } | null;
        // The session identity comes back as result.session.sessionId — Muse
        // selects its own default model (bundled catalog), so we do not
        // forward bb's placeholder model id and risk a rejection.
        sessionId = startRes?.session?.sessionId ?? null;
      } catch {
        sessionId = null;
      }
      openSession(parsed.data.threadId, providerThreadId, sessionId);
      respondResult(id, { providerThreadId });
      if (parsed.data.input !== undefined && parsed.data.input.length > 0) {
        await runMuseTurn({
          threadId: parsed.data.threadId,
          sessionId,
          input: parsed.data.input,
        });
      }
    })();
  },

  [BRIDGE_REQUEST_METHODS.threadResume]: (id, params) => {
    const parsed = threadResumeParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadResume, parsed.error.issues);
      return;
    }
    openSession(parsed.data.threadId, parsed.data.providerThreadId, null);
    respondResult(id, { providerThreadId: parsed.data.providerThreadId });
  },

  [BRIDGE_REQUEST_METHODS.turnStart]: (id, params) => {
    const parsed = turnStartParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnStart, parsed.error.issues);
      return;
    }
    const s = sessions.get(parsed.data.threadId);
    if (!s) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR,
        `No open session for thread ${parsed.data.threadId}`,
      );
      return;
    }
    respondResult(id, {});
    const model = turnModel(parsed.data);
    if (resolveEngine(model) === "exec") {
      void runExecTurn({
        threadId: parsed.data.threadId,
        input: parsed.data.input,
        clientRequestId: parsed.data.clientRequestId,
        model,
      });
      return;
    }
    void runMuseTurn({
      threadId: parsed.data.threadId,
      sessionId: s.sessionId,
      input: parsed.data.input,
      clientRequestId: parsed.data.clientRequestId,
    });
  },

  [BRIDGE_REQUEST_METHODS.turnSteer]: (id, params) => {
    const parsed = turnSteerParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.turnSteer, parsed.error.issues);
      return;
    }
    const s = sessions.get(parsed.data.threadId);
    if (!s || !s.activeTurn) {
      respondError(
        id,
        BRIDGE_JSON_RPC_ERRORS.NO_ACTIVE_TURN,
        `No active turn to steer (expected ${parsed.data.expectedTurnId})`,
      );
      return;
    }
    const text = parsed.data.input ? promptText(parsed.data.input as readonly PromptInput[]) : "";
    museNotify("turn/steer", {
      commandId: museMintCommandId(),
      sessionId: s.sessionId ?? s.providerThreadId,
      turnId: s.activeTurn,
      ...(text ? { text } : {}),
    });
    respondResult(id, {});
  },

  [BRIDGE_REQUEST_METHODS.threadStop]: (id, params) => {
    const parsed = threadStopParamsSchema.safeParse(params);
    if (!parsed.success) {
      invalidParams(id, BRIDGE_REQUEST_METHODS.threadStop, parsed.error.issues);
      return;
    }
    const s = sessions.get(parsed.data.threadId);
    if (s?.execChild) {
      try {
        s.execChild.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      s.execChild = null;
      closeTurn(parsed.data.threadId, "interrupted");
    } else if (s?.activeTurn) {
      museNotify("turn/cancel", {
        commandId: museMintCommandId(),
        sessionId: s.sessionId ?? s.providerThreadId,
        reason: { cancelledBy: "client", phase: "working" },
      });
      closeTurn(parsed.data.threadId, "interrupted");
    }
    sessions.delete(parsed.data.threadId);
    respondResult(id, {});
  },
};

// ---------------------------------------------------------------------------
// Line handling (exported so tests can drive the bridge in-process).
// ---------------------------------------------------------------------------

export function handleLine(line: string): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    return;
  }
  const { id, method, params } = message as {
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };
  if (typeof method !== "string") return;
  dbg("req id=" + String(id) + " method=" + method);
  if (typeof id !== "string" && typeof id !== "number") return;
  const handler = handlers[method];
  if (handler === undefined) {
    respondError(id, BRIDGE_JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${method}`);
    return;
  }
  handler(id, params);
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
  start() {
    void ensureMuse();
  },
});
