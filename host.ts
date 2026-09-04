/**
 * The plugin's single `bb.host` artifact. It exports `experimental_providerBridge`,
 * imported and driven by the daemon's bridge bootstrap in its own process — the
 * executable that launches `muse serve` and bridges MSP to bb's Provider Bridge
 * Protocol.
 */
export { experimental_providerBridge } from "./src/provider-bridge.js";
