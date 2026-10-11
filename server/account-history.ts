/** Native transcripts, diagnostics and executable caches are not credential storage. */
const histories = new Set(["sessions", "archived_sessions", "projects", "history", "logs", "debug", "file-history", "shell_snapshots", "shell-snapshots", "launchers", "cache", "tmp", "skills", "plugins", "node_modules"]);
export const isAccountHistory = (name: string): boolean => histories.has(name);
