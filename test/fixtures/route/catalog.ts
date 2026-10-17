import type { CatalogProvider } from "../../../src/route/types.ts";
const model = (id: string, option: string) => ({ id, options: [{ id: option, type: "select",
  options: ["low", "medium", "high", "xhigh", "max", "ultra", "ultrathink", "ultracode"].map(id => ({ id })) }] });
const codex = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].map(id => model(id, "reasoningEffort"));
const claude = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"].map(id => model(id, "effort"));
export const catalog: CatalogProvider[] = [
  { providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true, models: codex },
  { providerInstanceId: "codex-controlled", driverKind: "codex", canRunChildTask: false, models: codex },
  { providerInstanceId: "claudeAgent", driverKind: "claudeAgent", canRunChildTask: true, models: claude },
  ...["cursor", "grok", "opencode", "antigravity", "muse", "pi", "gemini", "devin", "githubCopilot"].map(id =>
    ({ providerInstanceId: id, driverKind: id, canRunChildTask: id === "opencode", models: [model("claude-haiku-5-5", "effort")] })),
  ...["claude-work", "claude-secondary", "codex-work", "codex-secondary", "opencode-local", "cursor-work"].map(id =>
    ({ providerInstanceId: id, driverKind: id.startsWith("claude") ? "claudeAgent" : id.startsWith("codex") ? "codex" : id,
      canRunChildTask: false, models: id.startsWith("claude") ? claude : codex })),
];
export const now = Date.parse("2026-10-17T12:00:00Z");
export const iso = (n: number) => new Date(n).toISOString();
