/**
 * Muse provider engine/config selection — pure helpers, dependency-free so they
 * can be unit-tested without loading the plugin SDK or the Muse SDK.
 *
 * Decide which mode the bridge runs: `serve` (persistent MSP session, minimal
 * external toolset, low token overhead — the default) vs `exec` (full
 * interactive toolset: web search, file edit, shell, subagents — chosen by
 * the ":tools" model variant or MUSE_ENGINE=exec).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MuseEngine = "serve" | "exec";

export function resolveMuseBin(): string {
  if (process.env.MUSE_CLI) return process.env.MUSE_CLI;
  const local = join(homedir(), ".local", "bin", "muse");
  if (existsSync(local)) return local;
  return "muse";
}

export function museCommand(): { cmd: string; args: string[] } {
  // Enable the widest tool/network surface `muse serve` offers: direct network
  // access (needed for any web work), workspace trust (session rules + skills),
  // and leave shell + write enabled (we never pass --disable-shell / --disable-write).
  const base = ["serve", "--sandbox-network", "enabled", "--trust-workspace"];
  return { cmd: resolveMuseBin(), args: base };
}

export function resolveEngine(model?: string): MuseEngine {
  if (model && model.endsWith(":tools")) return "exec";
  if (process.env.MUSE_ENGINE === "exec") return "exec";
  return "serve";
}

export function execWorkspaceFor(providerThreadId: string): string {
  return join(homedir(), ".bb", "muse-workspaces", providerThreadId);
}
