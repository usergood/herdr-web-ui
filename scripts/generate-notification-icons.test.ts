import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it("keeps both notification consumers synchronized with the bundled PNG files", () => {
  const result = Bun.spawnSync([process.execPath, "scripts/generate-notification-icons.ts", "--check"], { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
});
