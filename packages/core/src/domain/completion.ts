export const COMPLETION_SHELLS = ["bash", "zsh", "fish", "powershell"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];
