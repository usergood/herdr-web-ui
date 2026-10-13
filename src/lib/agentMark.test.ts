import { expect, test } from "bun:test";

import { fallbackInitial, hasBrandColors } from "./agentMark.ts";

test("private-use agent glyphs never become visible fallback text", () => {
  expect(fallbackInitial("")).toBe("?");
  expect(fallbackInitial("opencode")).toBe("O");
});

test("fallback initials preserve ordinary agent labels", () => {
  expect(fallbackInitial("deepseek")).toBe("D");
  expect(fallbackInitial("  claude ")).toBe("C");
});

test("distinguishes brand-colored marks for the Mono setting", () => {
  expect(["claude", "omp", "opencode", "gjc", "omo", "amp", "gemini"].every(hasBrandColors)).toBe(true);
  expect(["codex", "cursor", "cline", "pi", "unknown-agent"].some(hasBrandColors)).toBe(false);
});
