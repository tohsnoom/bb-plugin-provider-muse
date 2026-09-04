/**
 * Muse Code — a native BB agent provider plugin.
 *
 * Registers the provider and declares its pre-session capability facts; the
 * executable implementation is the provider bridge exported from `host.ts`
 * (the `bb.host` artifact), which launches `muse serve` and speaks the Muse
 * Server Protocol (MSP) to it. A provider with a `bb.host` entry but no
 * bridge export would be refused; exporting the bridge is what makes this a
 * working provider.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default function plugin(bb: BbPluginApi) {
  bb.providers.register({
    id: "muse",
    displayName: "Muse Code",
    icon: "Sparkles",
    capabilities: {
      supportsServiceTier: false,
      supportsNativeUserQuestion: false,
      fork: "none",
      supportsManualCompaction: false,
      supportsThreadArchive: false,
      supportsThreadRename: false,
      permissionModes: ["full"],
      reasoningLevels: ["medium"],
    },
    composerActions: [],
    // Model catalog scope: Muse's model set is determined by the installed
    // CLI + account, not per-workspace project config, so `host`.
    models: {
      scope: "host",
      fallback: [
        {
          id: "muse:spark-1.3",
          displayName: "Muse Spark 1.3",
          description:
            "Meta's flagship reasoning coding model, served through Muse Code.",
          supportedReasoningEfforts: [
            {
              reasoningEffort: "medium",
              description: "Balanced reasoning (Muse default)",
            },
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
        },
      ],
    },
    env: {
      // Allow an operator to point the bridge at a specific Muse CLI.
      passthrough: ["MUSE_CLI"],
    },
  });
}
