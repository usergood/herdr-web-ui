/** Exact terminal negotiation responses, never secret, submit or keyboard frames. */
export function isTerminalProtocolReply(frame: { type?: unknown; text?: unknown }): boolean {
  return frame.type === "input" && (frame.text === "\x1b[?1016;2$y" || frame.text === "\x1b[?1;2c");
}
