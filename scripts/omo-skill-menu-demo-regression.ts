import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { paneCommands } from "../server/commands.ts";
import type { SlashCommand } from "../shared/protocol.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// omo's `/` and `$` skill menu and its skill chips, on the unmodified app over the demo's fixture
// transport. The demo's omo pane answers Claude's command list and its chat names no skill, so the
// page's data is patched here, in the test only: the pane's agent is the case's (omo, and pi for
// the regression), its command list is omo's own builtins with three skills, and its conversation
// ends with a user turn that invokes two of them. Every case runs in a 1280×800 window and on a
// 390×844 phone; the screenshots and run.log go to omo-skill-menu/ under UI_EVIDENCE_DIR (CI's
// uploaded folder) or else evidence/. All files and HTTP
// traffic stay in this disposable, loopback-only app; no herdr session is opened.
const repo = join(import.meta.dir, "..");
const app = mkdtempSync(join(tmpdir(), "herdr-omo-skill-menu-demo-"));
/** an empty home: omo's builtins alone, none of this machine's skills */
const home = mkdtempSync(join(tmpdir(), "herdr-omo-skill-menu-home-"));
const evidence = join(process.env.UI_EVIDENCE_DIR || join(repo, "evidence"), "omo-skill-menu");
const TARGET = panes.docs;
const WIDTHS = [1280, 390] as const;
/** omo's own descriptions, as long as omo 5.1.34 ships them, and one of the person's own skills */
const SKILLS: Record<string, { description: string; origin: "bundled" | "user" }> = {
  "ulw-plan": { origin: "bundled", description: "Explore-first planning consultant that writes one decision-complete work plan before coding. Use only on an explicit user request for the ulw-plan workflow or a plan before implementation; it never self-activates on a bare ulw run." },
  "mass-ulw": { origin: "bundled", description: "Drives dependency-ordered child work through the native workflow tool, each phase's stages defined up front in one run, with retry/amend/send recovery. Use when the user asks for mass-ulw, a DAG of tasks, or fan-out work where some tasks must wait on others." },
  "review-work": { origin: "bundled", description: "Post-implementation gate review: run manual QA on the real surface yourself, then launch ONE gate reviewer (never a panel) to audit goal, constraints, code quality, security, missed context, and QA evidence. Use before a PR handoff or when the user explicitly asks to review completed work." },
  "docs-release": { origin: "user", description: "Writes the docs site's release notes from merged PRs. Use when cutting a docs release; never for the app's own changelog." },
  // one sentence with no full stop, too long for the row: nothing is cut from the text, the row cuts it, and the tooltip still holds it
  "preview-deploy": { origin: "user", description: "Builds the docs site, deploys it to a throwaway preview host and posts the address on the pull request it was asked from, then tears the host down once that pull request closes" },
};
const COMMANDS: SlashCommand[] = [
  ...paneCommands("omo", "/home/demo/docs-site", home, {}),
  ...Object.entries(SKILLS).map(([name, { description, origin }]) => ({ name: `skill:${name}`, description, source: "skill" as const, origin })),
];
/** each omo row's description: one line, no second sentence, the whole text in its tooltip */
const rowDescriptions = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".composer-menu .menu-item")].map((row) => {
  const hint = row.querySelector<HTMLElement>(".menu-item-hint")!;
  return {
    name: row.querySelector<HTMLElement>(".menu-item-main")!.textContent,
    hint: hint.textContent ?? "",
    lines: Math.round(hint.getBoundingClientRect().height / parseFloat(getComputedStyle(hint).lineHeight || "16")),
    title: row.getAttribute("title"),
    origin: row.getAttribute("data-origin"),
    icon: row.querySelector(":scope > svg") !== null,
  };
}));
const rowsBrief = async (page: Page, what: string): Promise<void> => {
  for (const row of await rowDescriptions(page)) {
    assert.ok(row.lines <= 1, `${what}: ${row.name}'s description takes one line: ${JSON.stringify(row)}`);
    assert.ok(!/[.!?]\s+[A-Z]/u.test(row.hint), `${what}: ${row.name}'s description is one sentence: ${JSON.stringify(row)}`);
    const skill = SKILLS[row.name.replace(/^[/$]skill:/u, "")];
    if (skill === undefined) continue;
    assert.equal(row.origin, skill.origin, `${what}: ${row.name} says whose it is`);
    assert.ok(row.icon, `${what}: ${row.name} has its origin's icon`);
    assert.equal(row.title, skill.description, `${what}: ${row.name}'s whole description is its tooltip`);
  }
};
/** the user turn the omo chat ends with: one skill typed inline, one recorded by omo as its placeholder */
const TURN_TEXT = "please run $skill:mass-ulw now, then [skill: ulw-plan] for what is left";
const CHIPS = ["$skill:mass-ulw", "[skill: ulw-plan]"];

const lines: string[] = [];
const log = (line: string): void => { lines.push(line); console.log(line); };
const failures: string[] = [];

const menu = (page: Page) => page.locator(".composer-menu");
/** the rows as drawn: the typed `/` or `$`, then the command's name */
const rowLabels = (page: Page): Promise<string[]> => menu(page).locator(".menu-item-main").allTextContents();
const rowNames = async (page: Page): Promise<string[]> => (await rowLabels(page)).map((row) => row.replace(/^[/$]/u, ""));

const menuGeometry = (page: Page) => page.evaluate(() => {
  const menu = document.querySelector<HTMLElement>(".composer-menu")!;
  const box = menu.getBoundingClientRect();
  const input = document.querySelector<HTMLElement>(".composer-text")!.getBoundingClientRect();
  const rows = [...menu.querySelectorAll<HTMLElement>(".menu-item")];
  const rects = rows.map((row) => row.getBoundingClientRect());
  return {
    rows: rows.length,
    selected: rows.findIndex((row) => row.getAttribute("aria-selected") === "true"),
    fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
    aboveInput: box.bottom <= input.top + 0.5,
    // a row the column shrank spills its text over the next one: no two rows share a pixel
    overlapping: rects.filter((rect, index) => index > 0 && Math.min(rect.bottom, rects[index - 1]!.bottom) - Math.max(rect.top, rects[index - 1]!.top) > 0.5).length,
    // a command's name is drawn whole; only its description may give way
    clipped: rows.map((row) => row.querySelector<HTMLElement>(".menu-item-main")!).filter((main) => main.scrollWidth > main.clientWidth + 1).map((main) => main.textContent),
    overflowing: document.documentElement.scrollWidth > innerWidth,
  };
});
const menuFits = async (page: Page, what: string): Promise<void> => {
  const geometry = await menuGeometry(page);
  assert.ok(geometry.fits && geometry.aboveInput, `${what}: the menu sits inside the viewport, over the message box: ${JSON.stringify(geometry)}`);
  assert.equal(geometry.overlapping, 0, `${what}: no row overlaps the one before it: ${JSON.stringify(geometry)}`);
  assert.deepEqual(geometry.clipped, [], `${what}: every name is drawn whole`);
  assert.equal(geometry.overflowing, false, `${what}: the page does not scroll sideways`);
};

const chipGeometry = (page: Page) => page.evaluate(() => {
  const turns = document.querySelectorAll<HTMLElement>(".chat-turn-user");
  const turn = turns[turns.length - 1]!;
  const body = turn.querySelector<HTMLElement>(".chat-bubble-body")!;
  const box = body.getBoundingClientRect();
  const rects = [...turn.querySelectorAll<HTMLElement>(".markdown-skill")].map((chip) => chip.getBoundingClientRect());
  return {
    text: body.textContent,
    chips: [...turn.querySelectorAll<HTMLElement>(".markdown-skill")].map((chip) => chip.textContent),
    inside: rects.every((rect) => rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5 && rect.top >= box.top - 0.5 && rect.bottom <= box.bottom + 0.5),
    onScreen: rects.every((rect) => rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight),
    overlapping: rects.some((a, index) => rects.slice(index + 1).some((b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5)),
    overflowing: document.documentElement.scrollWidth > innerWidth,
  };
});

/**
 * One case. Its screenshot is taken where the case asks for it (`capture`), or at the failure when
 * it fails before that, so the evidence shows the state that was asserted. A failure ends the case,
 * not the run: every case at every width leaves its picture, and the run fails at the end.
 */
const scenario = async (page: Page, name: string, file: string | null, run: (capture: () => Promise<void>) => Promise<void>): Promise<void> => {
  let captured = false;
  const capture = async (): Promise<void> => {
    if (captured || file === null) return;
    captured = true;
    await page.screenshot({ path: join(evidence, file) });
    log(`  ${file}`);
  };
  try {
    await run(capture);
    log(`PASS ${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try { await capture(); } catch (shot) { log(`  (no screenshot: ${shot instanceof Error ? shot.message : String(shot)})`); }
    failures.push(`${name}: ${message}`);
    log(`FAIL ${name}: ${message}`);
  }
};

try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  // What the demo answers, rewritten as it is read (`window.skillCase` is set per browser context).
  const patch = `<script>(() => {
    const TARGET = ${JSON.stringify(TARGET)};
    const COMMANDS = ${JSON.stringify(COMMANDS)};
    const TURN_TEXT = ${JSON.stringify(TURN_TEXT)};
    const fix = (value) => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) { value.forEach(fix); return value; }
      // the pane, in a snapshot's panes and agents: the case's agent
      if (value.pane_id === TARGET && "agent_status" in value && "agent" in value) value.agent = window.skillCase.agent;
      // GET /api/pane/commands: omo's list
      if (Array.isArray(value.commands)) value.commands = COMMANDS.map((command) => ({ ...command }));
      // GET /api/pane/conversation of the omo chat: one more user turn, half a minute after the last
      if (value.source === "omo-transcript" && Array.isArray(value.turns) && !value.turns.some((turn) => turn.role === "user" && turn.parts.some((part) => part.kind === "text" && part.text === TURN_TEXT))) {
        const last = value.turns[value.turns.length - 1];
        const at = last ? Date.parse(last.end_ts ?? last.ts) + 30_000 : Date.now();
        value.turns.push({ role: "user", ts: new Date(at).toISOString(), parts: [{ kind: "text", text: TURN_TEXT }] });
      }
      for (const key of Object.keys(value)) fix(value[key]);
      return value;
    };
    const clone = structuredClone;
    window.structuredClone = (value, options) => fix(clone(value, options));
    const parse = JSON.parse;
    JSON.parse = function (text, reviver) { return fix(parse.call(JSON, text, reviver)); };
    const json = Response.prototype.json;
    Response.prototype.json = async function () { return fix(await json.call(this)); };
  })();</script>`;
  writeFileSync(index, html.replace(/<script type="module"/, () => `${patch}\n    <script src="./demo-transport.js"></script>\n    <script type="module"`));

  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/herdr-web-ui/demo/app/")) return new Response("not found", { status: 404 });
    let file: string;
    try { file = decodeURIComponent(path.slice("/herdr-web-ui/demo/app/".length)); }
    catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return (await body.exists()) ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(TARGET)}`;
  mkdirSync(evidence, { recursive: true });

  /** The omo pane's chat, in a mouse-driven window of `width` or on a phone (390px, touch), with the agent the case asks for. */
  const withPane = async (browser: Browser, width: number, agent: "omo" | "pi", run: (page: Page) => Promise<void>): Promise<void> => {
    const touch = width <= 480;
    const context = await browser.newContext({ viewport: { width, height: touch ? 844 : 800 }, hasTouch: touch, isMobile: touch, locale: "en-US" });
    try {
      await context.addInitScript((skillCase) => {
        if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en" }));
        Object.assign(window, { skillCase });
      }, { agent });
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(url);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      if (await page.locator(".terminal-stack.is-chat").count() === 0) await page.getByTitle("Chat transcript (⌘⇧J)", { exact: true }).click();
      await page.locator(".terminal-stack.is-chat").waitFor();
      await page.locator(".chat-turn-user").first().waitFor();
      await appFaces(page);
      await run(page);
      if (errors.length > 0) failures.push(`${agent} pane at ${width}px: page errors: ${errors.join(" | ")}`);
    } finally {
      await context.close();
    }
  };

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const width of WIDTHS) await withPane(browser, width, "omo", async (page) => {
        const box = page.getByRole("textbox", { name: "Message", exact: true });
        const clear = async (): Promise<void> => {
          await box.fill("");
          await menu(page).waitFor({ state: "detached" });
        };

        await scenario(page, `A: "/" lists omo's builtins and its skills (${width}px)`, `a-slash-${width}.png`, async (capture) => {
          await box.fill("/");
          await menu(page).locator(".menu-item").filter({ hasText: "/compact" }).waitFor();
          const rows = await rowNames(page);
          assert.ok(rows.includes("skill:mass-ulw") && rows.includes("compact"), `the menu lists skill:mass-ulw and compact: ${rows.join(" ")}`);
          assert.ok(!rows.includes("tree"), `the menu does not list tree: ${rows.join(" ")}`);
          assert.deepEqual([...rows].sort(), COMMANDS.map((command) => command.name).sort(), "every omo command is offered, once");
          const headings = await menu(page).locator(".menu-heading").allTextContents();
          assert.ok(headings.includes("Your skills") && headings.includes("Built-in skills") && !headings.includes("Skills"), `yours and omo's stand under their own headings: ${headings.join(" | ")}`);
          assert.ok(headings.indexOf("Your skills") < headings.indexOf("Built-in skills"), "yours first");
          await menuFits(page, "A");
          await rowsBrief(page, "A");
          // the skills end the list: the capture shows their heading and rows after the last builtins
          await menu(page).evaluate((node) => { node.scrollTop = node.scrollHeight; });
          await capture();
          log(`  ${rows.length} rows, skills: ${rows.filter((row) => row.startsWith("skill:")).join(", ")}`);
        });

        await scenario(page, `B: "/skill:ul" ranks skill:ulw-plan first and Enter inserts it (${width}px)`, `b-slash-pick-${width}.png`, async (capture) => {
          await clear();
          await box.fill("/skill:ul");
          await menu(page).locator(".menu-item").first().waitFor();
          const rows = await rowNames(page);
          assert.equal(rows[0], "skill:ulw-plan", `the first row is skill:ulw-plan: ${rows.join(" ")}`);
          assert.equal((await rowLabels(page))[0], "/skill:ulw-plan", "drawn with the typed /");
          assert.equal((await menuGeometry(page)).selected, 0, "and it is the highlighted one");
          await menuFits(page, "B");
          await rowsBrief(page, "B");
          await capture();
          await box.press("Enter");
          assert.equal(await box.inputValue(), "/skill:ulw-plan ");
          await menu(page).waitFor({ state: "detached" });
          log(`  rows: ${rows.join(", ")}; Enter wrote ${JSON.stringify(await box.inputValue())}`);
        });

        await scenario(page, `C: "run with $mas" offers the skills matching mas and Enter inserts $skill:mass-ulw (${width}px)`, `c-dollar-${width}.png`, async (capture) => {
          await clear();
          await box.fill("run with $mas");
          await menu(page).locator(".menu-item").first().waitFor();
          const rows = await rowNames(page);
          assert.deepEqual(rows, Object.keys(SKILLS).filter((name) => name.includes("mas")).map((name) => `skill:${name}`), "exactly the skill rows matching \"mas\"");
          const labels = await rowLabels(page);
          assert.ok(labels.every((label) => label.startsWith("$skill:")), `drawn with the typed $, as Enter will write them: ${labels.join(" ")}`);
          await menuFits(page, "C");
          await rowsBrief(page, "C");
          await capture();
          await box.press("Enter");
          assert.equal(await box.inputValue(), "run with $skill:mass-ulw ");
          await menu(page).waitFor({ state: "detached" });
          log(`  rows: ${rows.join(", ")}; Enter wrote ${JSON.stringify(await box.inputValue())}`);
        });

        await scenario(page, `D: the user's message shows chips for mass-ulw and ulw-plan (${width}px)`, `d-chips-${width}.png`, async (capture) => {
          await clear();
          const turn = page.locator(".chat-turn-user").last();
          await turn.locator(".chat-bubble-body").filter({ hasText: "please run" }).waitFor();
          await turn.scrollIntoViewIfNeeded();
          // the matcher arrives with the pane's command list: a bounded wait, not a fixed one
          const drawn = await turn.locator(".markdown-skill").first().waitFor({ timeout: 5_000 }).then(() => true, () => false);
          const state = await chipGeometry(page);
          await capture();
          assert.ok(drawn, `the bubble shows the text but no .markdown-skill chip: ${JSON.stringify(state)}`);
          assert.deepEqual(state.chips, CHIPS, `a chip for each skill, in the form it was written: ${JSON.stringify(state)}`);
          assert.ok(state.inside && state.onScreen && !state.overlapping && !state.overflowing, `the chips sit whole inside the bubble and the screen, apart: ${JSON.stringify(state)}`);
          log(`  chips: ${state.chips.join(", ")}`);
        });
      });

      for (const width of WIDTHS) await withPane(browser, width, "pi", async (page) => {
        await scenario(page, `E: a pi pane opens no menu for "x $" (${width}px)`, null, async () => {
          const box = page.getByRole("textbox", { name: "Message", exact: true });
          await box.fill("x $");
          await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer-text")?.value === "x $");
          assert.equal(await box.getAttribute("aria-expanded"), "false", "the message box names no open menu");
          assert.equal(await menu(page).count(), 0, "no .composer-menu");
          await box.fill("/");
          await menu(page).locator(".menu-item").first().waitFor();
          assert.equal(await box.getAttribute("aria-expanded"), "true", "the same pane's own / menu opens");
          // the command list is loaded (the menu drew it): the same message stays plain text in a pane that is not omo's
          const turn = page.locator(".chat-turn-user").last();
          await turn.locator(".chat-bubble-body").filter({ hasText: "please run" }).waitFor();
          assert.equal(await turn.locator(".markdown-skill").count(), 0, "no skill chip in a pi pane's message");
        });
      });
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
}

log(failures.length === 0
  ? `PASS omo skill menu and chips: ${WIDTHS.length * 4} screenshots in ${evidence}`
  : `FAIL ${failures.length} case(s):\n${failures.map((failure) => `  - ${failure}`).join("\n")}`);
writeFileSync(join(evidence, "run.log"), lines.join("\n") + "\n");
if (failures.length > 0) process.exitCode = 1;
