import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  execWorkspaceFor,
  museCommand,
  resolveEngine,
  resolveMuseBin,
} from "../src/engine.js";

afterEach(() => {
  delete process.env.MUSE_ENGINE;
  delete process.env.MUSE_CLI;
});

describe("resolveEngine", () => {
  it("defaults to serve with no model and no env", () => {
    expect(resolveEngine()).toBe("serve");
    expect(resolveEngine("muse:spark-1.3")).toBe("serve");
  });

  it("selects exec for a :tools model variant", () => {
    expect(resolveEngine("muse:spark-1.3:tools")).toBe("exec");
  });

  it("selects exec via MUSE_ENGINE=exec", () => {
    process.env.MUSE_ENGINE = "exec";
    expect(resolveEngine()).toBe("exec");
    expect(resolveEngine("muse:spark-1.3")).toBe("exec");
  });

  it("model variant wins over default even without env", () => {
    expect(resolveEngine("muse:spark-1.3:tools")).toBe("exec");
  });
});

describe("resolveMuseBin", () => {
  it("honors MUSE_CLI when set", () => {
    process.env.MUSE_CLI = "/opt/muse/muse-bin";
    expect(resolveMuseBin()).toBe("/opt/muse/muse-bin");
  });
});

describe("museCommand", () => {
  it("uses MUSE_CLI as the command", () => {
    process.env.MUSE_CLI = "/opt/muse/muse";
    expect(museCommand().cmd).toBe("/opt/muse/muse");
  });

  it("always serves with network and workspace trust flags (widest surface)", () => {
    expect(museCommand().args).toEqual([
      "serve",
      "--sandbox-network",
      "enabled",
      "--trust-workspace",
    ]);
  });
});

describe("execWorkspaceFor", () => {
  it("points at the per-thread workspace under ~/.bb", () => {
    expect(execWorkspaceFor("thr_abc123")).toBe(
      join(homedir(), ".bb", "muse-workspaces", "thr_abc123"),
    );
  });
});
