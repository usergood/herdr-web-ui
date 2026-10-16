import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { runMoreItem } from "./header-more.ts";
import { chromePath } from "./chrome-path.ts";

// Settings → Agents order (Activity) and the Agents list's pins, on the unmodified app over the
// demo's fixture transport, whose agents carry herdr's state_change_seq and bump it on every state
// change. The demo's Claude pane finishes by itself 4.5s in (site/demo/transport.ts), and a message
// sent from a chat runs for 2.4s and then finishes. All files and HTTP traffic stay in this
// disposable, loopback-only app; no herdr session is opened.
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-activity-demo-"));

const API = "Idempotent payments";        // claude, working, finishes by itself
const WEB = "Guard the export button";    // codex, blocked
const INFRA = "Why did the backup fail?"; // idle: the agent a message is sent from
const AGENTS_HERDR_ORDER = [API, WEB, INFRA, "Proofread the guide", "Ship the retry flag"];

const agents = (page: Page) => page.locator(".agents-sidebar .agent-item");
const agentTitles = (page: Page) => agents(page).locator(".agent-title").allTextContents();
const agent = (page: Page, title: string) => agents(page).filter({ has: page.locator(".agent-title", { hasText: title }) });
const agentStatus = (page: Page, title: string) => agent(page, title).locator(".sidebar-status").getAttribute("data-status");
const waitStatus = (page: Page, title: string, status: string) => agent(page, title).locator(`.sidebar-status[data-status="${status}"]`).waitFor({ timeout: 10_000 });
const waitAgentAt = (page: Page, index: number, title: string) => page.waitForFunction(([at, name]) =>
  [...document.querySelectorAll(".agents-sidebar .agent-item .agent-title")][at as number]?.textContent === name, [index, title] as const, { timeout: 5_000 });

/**
 * `seen`: a record already in this browser, so first-use seeding does not run. Seeding counts what
 * is open at the first roster as opened, and a page slower than the demo's 4.5s self-finish would
 * count that finish too (#529 review): a record there already makes the run independent of load time.
 */
async function withPage(browser: Browser, settings: object, run: (page: Page) => Promise<void>, seen?: Record<string, number>, mobile = false): Promise<void> {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: mobile, hasTouch: mobile, locale: "en-US",
  });
  try {
    await context.addInitScript(({ stored, seen }) => {
      localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "chat", sidebarRows: "two", ...stored }));
      if (seen !== undefined) localStorage.setItem("herdr-web-ui:seen:local", JSON.stringify(seen));
    }, { stored: settings, seen });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // the shell pane is on screen, so the demo's own finish happens out of sight
    await page.goto(`${url}?pane=${encodeURIComponent(panes.shell)}`);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await agents(page).first().waitFor({ state: "attached" });
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

let url = "";
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, '<script src="./demo-transport.js"></script>\n    <script type="module"'));

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
  url = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;

  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      // Workspace menus no longer mix in pane operations; header More keeps pane movement.
      // off by default: herdr's order in a flat list, each row naming its own workspace
      await withPage(browser, {}, async (page) => {
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER);
        assert.equal(await page.locator(".agents-sidebar .agent-group").count(), 0, "no workspace cards unless Settings turns them on");
        assert.equal(await page.locator(".agents-sidebar .agent-pin-toggle").count(), 0, "no pin stars unless Settings turns them on");
        assert.match(await agent(page, API).locator(".agent-context").textContent() ?? "", /checkout-api/, "a row outside a card names its workspace");
      });
      console.log("PASS by default the Agents list is flat, in herdr's order, with no pin stars");

      // a pane's plan: the composer's chip shows how far it got and opens its steps, as the background
      // tasks do; the header carries no plan of its own
      for (const mobile of [false, true]) {
        await withPage(browser, {}, async (page) => {
          await page.goto(`${url}?pane=${encodeURIComponent(panes.api)}`);
          await page.locator(".conn-live").waitFor({ state: "attached" });
          const chip = page.locator(".composer .bg-tasks-toggle");
          await chip.waitFor();
          assert.match(await chip.getAttribute("aria-label") ?? "", /^Plan: 1 of \d+ done/, "the chip names the plan's progress");
          assert.match((await chip.locator(".bg-tasks-plan").textContent())?.trim() ?? "", /^1\/\d+$/);
          assert.equal(await page.locator(".plan-button").count(), 1, "the fork retains its header plan flow control");
          await chip.click();
          const list = page.getByRole("dialog", { name: /^Plan/ });
          await list.locator(".bg-step").first().waitFor();
          assert.equal(await list.locator(".bg-step.is-in_progress").count(), 1, "the running step is marked");
          assert.equal(await list.locator(".plan-node, .plan-view-switch").count(), 0, "no flow of boxes");
          await page.keyboard.press("Escape");
          await list.waitFor({ state: "detached" });
        }, undefined, mobile);
      }
      console.log("PASS a pane's plan opens from the composer's chip, as a list of steps, on a desktop and a phone");

      await withPage(browser, {}, async (page) => {
        await runMoreItem(page, "Move pane to…");
        const move = page.getByRole("menu", { name: /^Move .* to$/ });
        await move.waitFor();
        assert.equal(await move.getByRole("menuitem", { name: "New tab", exact: true }).count(), 1);
        const previousTab = await page.locator('.tab-strip-tab[aria-selected="true"]').getAttribute("data-tab-id");
        await move.getByRole("menuitem", { name: "New tab", exact: true }).click();
        await page.waitForFunction((previous) => {
          const active = document.querySelector('.tab-strip-tab[aria-selected="true"]');
          return active !== null && active.getAttribute("data-tab-id") !== previous;
        }, previousTab);
        assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id), panes.shell, "header More moves the selected pane");
        const movedTab = await page.evaluate(async (paneId) => {
          const { snapshot } = await (await fetch("/api/session")).json();
          return snapshot.panes.find((pane: { pane_id: string }) => pane.pane_id === paneId)?.tab_id;
        }, panes.shell);
        assert.equal(await page.locator('.tab-strip-tab[aria-selected="true"]').getAttribute("data-tab-id"), movedTab);
        // A stale menu must disappear if another client closes its target.
        await runMoreItem(page, "Move pane to…");
        await move.waitFor();
        await page.evaluate(async (paneId) => {
          const response = await fetch("/api/pane/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pane_id: paneId }) });
          if (!response.ok) throw new Error(`Close fixture failed: ${response.status}`);
        }, panes.shell);
        await move.waitFor({ state: "detached" });
      });
      console.log("PASS header More moves the selected pane and closes stale targets");

      // A favorite adds a shortcut; the complete repository tree stays in place.
      for (const [theme, mobile] of [["dark", false], ["dark", true], ["light", false], ["light", true]] as const) {
        await withPage(browser, { theme }, async (page) => {
          if (mobile) await page.locator('button[aria-controls="workspace-drawer"]').tap();
          const tree = page.locator(".machine-workspaces .sidebar-list > .workspace-list:not(.sidebar-pinned)");
          const head = tree.locator(`.workspace-select[data-pane="${panes.api}"]`);
          const headId = await head.evaluate((row) => row.closest(".workspace-group")?.getAttribute("data-workspace"));
          assert.ok(headId);
          const worktrees = await page.evaluate(async (workspaceId) => {
            const made: { workspace_id: string; pane_id: string }[] = [];
            for (const branch of ["pin-first", "pin-second"]) {
              const response = await fetch("/api/worktree/create", {
                method: "POST", headers: { "content-type": "application/json" },
                body: JSON.stringify({ workspace_id: workspaceId, branch }),
              });
              if (!response.ok) throw new Error(`worktree fixture: ${response.status}`);
              made.push(await response.json());
            }
            return made;
          }, headId);
          for (const { pane_id } of worktrees) await page.locator(`.workspace-select[data-pane="${pane_id}"]`).waitFor();
          const titles = () => tree.locator(".workspace-name").allTextContents();
          const groupedOrder = await titles();
          const headName = await head.locator(".workspace-name").textContent();
          const setPin = async (pin: boolean) => {
            await head.focus();
            if (mobile) await tree.locator(`.workspace-group[data-workspace="${headId}"] > .workspace-header .row-menu-toggle`).tap();
            else await head.click({ button: "right" });
            const label = pin ? "Pin workspace" : "Unpin workspace";
            const panel = page.getByRole(mobile ? "dialog" : "menu");
            if (mobile) await panel.getByRole("button", { name: label, exact: true }).tap();
            else await panel.getByRole("menuitem", { name: label, exact: true }).click();
            await panel.waitFor({ state: "detached" });
          };
          await setPin(true);
          const card = page.locator(".machine-workspaces .sidebar-pinned");
          await card.waitFor();
          assert.deepEqual(await card.locator(".workspace-name").allTextContents(), [headName], "pinning a repository pins only its own row, not its worktrees");
          assert.deepEqual(await titles(), groupedOrder, "favorites keep the complete repository tree unchanged");
          assert.equal(await head.evaluate((row) => document.activeElement === row), true, "pinning from the tree restores focus to the tree row");
          const shortcut = card.locator(`.workspace-select[data-pane="${panes.api}"]`);
          assert.notEqual(await shortcut.evaluate((row) => row.closest(".workspace-group")?.id), await head.evaluate((row) => row.closest(".workspace-group")?.id), "shortcut and tree row have distinct element ids");
          assert.equal(await head.getAttribute("aria-keyshortcuts"), "Alt+ArrowUp Alt+ArrowDown", "the pinned repository keeps its within-card reorder shortcuts");
          assert.equal(await head.getAttribute("draggable"), mobile ? "false" : "true", "the pinned repository supports desktop drag while touch uses long-press");
          for (const { workspace_id, pane_id } of worktrees) {
            const row = page.locator(`.workspace-select[data-pane="${pane_id}"]`);
            assert.equal(await row.evaluate((element) => element.closest(".worktree-children") !== null), true, "worktrees stay nested below their favorite repository");
            assert.equal(await row.getAttribute("draggable"), mobile ? "false" : "true", "tree worktrees keep normal drag behavior");
            assert.equal(await row.getAttribute("aria-keyshortcuts"), "Alt+ArrowUp Alt+ArrowDown", "tree worktrees keep reorder shortcuts");
            assert.equal(await page.locator(`.workspace-group[data-workspace="${workspace_id}"]`).count(), 1, "each worktree appears once");
          }
          // A favorite worktree stays available even when its repository is collapsed.
          const firstTree = tree.locator(`.workspace-select[data-pane="${worktrees[0]!.pane_id}"]`);
          await firstTree.focus();
          if (mobile) await firstTree.locator("..").locator(".row-menu-toggle").tap();
          else await page.keyboard.press("Shift+F10");
          const worktreePanel = page.getByRole(mobile ? "dialog" : "menu");
          await worktreePanel.getByRole(mobile ? "button" : "menuitem", { name: "Pin workspace", exact: true }).click();
          await worktreePanel.waitFor({ state: "detached" });
          const worktreeShortcut = card.locator(`.workspace-select[data-pane="${worktrees[0]!.pane_id}"]`);
          await worktreeShortcut.waitFor();
          assert.deepEqual(await titles(), groupedOrder, "pinning a worktree preserves its tree position");
          await worktreeShortcut.focus();
          await page.keyboard.press("Alt+ArrowUp");
          assert.deepEqual(await card.locator(".workspace-name").allTextContents(), ["pin-first", headName], "a worktree shortcut reorders independently of the tree");
          assert.deepEqual(await titles(), groupedOrder, "shortcut reordering does not move tree worktrees");
          const fold = tree.getByRole("button", { name: `Collapse worktrees of ${headName}`, exact: true });
          await fold.click();
          assert.equal(await firstTree.count(), 0, "collapsing hides the unselected tree worktree");
          assert.equal(await worktreeShortcut.isVisible(), true, "collapsing never hides its favorite shortcut");
          await worktreeShortcut.click();
          await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id === paneId, worktrees[0]!.pane_id);
          if (mobile) await page.locator('button[aria-controls="workspace-drawer"]').tap();
          assert.equal(await worktreeShortcut.getAttribute("aria-current"), "true", "shortcut reflects the selected workspace");
          assert.equal(await firstTree.getAttribute("aria-current"), "true", "its tree row reflects the same selected workspace");
          await worktreeShortcut.focus();
          if (mobile) await worktreeShortcut.locator("..").locator(".row-menu-toggle").tap();
          else await page.keyboard.press("Shift+F10");
          await worktreePanel.getByRole(mobile ? "button" : "menuitem", { name: "Unpin workspace", exact: true }).click();
          await worktreePanel.waitFor({ state: "detached" });
          assert.equal(await worktreeShortcut.count(), 0, "unpin removes only the shortcut");
          assert.equal(await firstTree.evaluate((row) => document.activeElement === row), true, "unpinning a shortcut returns focus to its tree row");
          assert.deepEqual(await titles(), groupedOrder, "unpinning a worktree leaves the full tree intact");
          await firstTree.focus();
          await page.keyboard.press("Alt+ArrowDown");
          const reordered = [...groupedOrder];
          const firstAt = reordered.indexOf("pin-first");
          assert.ok(firstAt >= 0);
          [reordered[firstAt], reordered[firstAt + 1]] = [reordered[firstAt + 1]!, reordered[firstAt]!];
          assert.deepEqual(await titles(), reordered, "tree worktrees reorder normally under a favorite repository");
          await page.keyboard.press("Alt+ArrowUp");
          assert.deepEqual(await titles(), groupedOrder, "tree worktree order can be restored independently of favorites");
          await shortcut.focus();
          if (mobile) await shortcut.locator("..").locator(".row-menu-toggle").tap();
          else await page.keyboard.press("Shift+F10");
          const renamePanel = page.getByRole(mobile ? "dialog" : "menu");
          await renamePanel.getByRole(mobile ? "button" : "menuitem", { name: "Rename workspace", exact: true }).click();
          await renamePanel.waitFor({ state: "detached" });
          assert.equal(await card.locator(".workspace-rename-input").count(), 1, "rename edits only the shortcut used");
          assert.equal(await tree.locator(".workspace-rename-input").count(), 0, "rename does not open a duplicate tree editor");
          await card.locator(".workspace-rename-input").press("Enter");
          const evidence = process.env["UI_EVIDENCE_DIR"];
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.screenshot({ path: join(evidence, `pin-repository-${mobile ? "phone" : "desktop"}-${theme}.png`), animations: "disabled" });
          }
          await setPin(false);
          await card.waitFor({ state: "detached" });
          assert.deepEqual(await titles(), groupedOrder, "unpinning restores the repository group and order");
          for (const { pane_id } of worktrees) {
            assert.equal(await page.locator(`.worktree-children .workspace-select[data-pane="${pane_id}"]`).count(), 1, "unpinning nests the worktree under its repository again");
          }
        }, undefined, mobile);
      }
      console.log("PASS repository favorites add only a shortcut and preserve the full movable tree on desktop and phone");

      // Default: herdr's order before and after a finish, and an opened DONE keeps herdr's dot
      await withPage(browser, { agentCards: true, agentPins: true }, async (page) => {
        const selected = await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"));
        await page.locator(".header-more-button").focus();
        const workspace = page.locator(`.workspace-select[data-pane="${panes.api}"]`);
        const bounds = (await workspace.boundingBox())!;
        await workspace.click({ button: "right", position: { x: 32, y: bounds.height / 2 } });
        const menu = page.getByRole("menu", { name: "checkout-api", exact: true });
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Pin workspace", "Rename workspace", "Close workspace", "New worktree", "Open worktree…"], "right-click uses native workspace scope");
        const opened = (await menu.boundingBox())!;
        assert.ok(Math.abs(opened.x - bounds.x - 32) <= 1 && Math.abs(opened.y - bounds.y - bounds.height / 2) <= 1, "the menu opens at the pointer");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selected, "right-click leaves the selected pane alone");
        await page.keyboard.press("Escape");
        assert.equal(await page.locator(".header-more-button").evaluate((button) => document.activeElement === button), true, "dismissal returns the prior keyboard focus");
        await workspace.focus();
        await page.keyboard.press("Shift+F10");
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Pin workspace", "Rename workspace", "Close workspace", "New worktree", "Open worktree…"], "the keyboard menu and right-click have identical items");
        await page.keyboard.press("Escape");
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        // pin an agent that is not first: it stays in its workspace's card, and that card leads the list
        const pinnedRow = agent(page, INFRA);
        const pin = pinnedRow.getByRole("button", { name: `Pin agent: ${INFRA} · infra`, exact: true });
        assert.equal(await pin.count(), 1, "each agent has a pin control named for it and its workspace");
        const pinFocused = () => pinnedRow.locator(".agent-pin-toggle").evaluate((star) => document.activeElement === star);
        assert.equal(await pin.getAttribute("aria-pressed"), "false");
        await pin.focus();
        await page.keyboard.press("Space");
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.infra}`);
        assert.equal(await pin.getAttribute("aria-pressed"), "true", "keyboard pin persists the agent and keeps the control's name");
        assert.equal(await pinFocused(), true, "the star keeps the keyboard focus as its card moves up");
        assert.deepEqual(await agentTitles(page), [INFRA, ...AGENTS_HERDR_ORDER.filter((title) => title !== INFRA)], "a pinned agent moves to the top, the rest keep herdr's order");
        const pinnedLayout = () => page.evaluate((title) => {
          const first = document.querySelector(".agents-sidebar .agent-list")!.firstElementChild;
          return {
            inCard: [...document.querySelectorAll(".agents-sidebar .agent-group .agent-title")].some((node) => node.textContent === title),
            firstCard: first?.classList.contains("agent-group") === true ? first.querySelector(".agent-group-name")?.textContent : null,
            firstInCard: first?.querySelector(".agent-group-rows .agent-title")?.textContent ?? null,
          };
        }, INFRA);
        assert.deepEqual(await pinnedLayout(), { inCard: true, firstCard: "infra", firstInCard: INFRA }, "the pinned agent stays in its card, first there, and its card leads the list");
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await agents(page).first().waitFor({ state: "attached" });
        assert.deepEqual(await pinnedLayout(), { inCard: true, firstCard: "infra", firstInCard: INFRA }, "the pin survives a reload");
        await pin.focus();
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").length === 0);
        assert.equal(await pinFocused(), true, "the star keeps the keyboard focus as its card moves back");
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER, "unpin restores the source order");
        assert.equal((await pinnedLayout()).firstCard, "checkout-api", "unpinned, its card returns to herdr's order");
        await agentSelect.focus();
        await page.keyboard.press("Shift+F10");
        const agentMenu = page.getByRole("menu", { name: API, exact: true });
        await agentMenu.waitFor();
        assert.deepEqual(await agentMenu.getByRole("menuitem").allTextContents(), ["Pin agent"]);
        await page.keyboard.press("Escape");
        await agentSelect.click({ button: "right" });
        await agentMenu.waitFor();
        assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selected, "agent right-click does not select it");
        await page.keyboard.press("Escape");
        console.log("PASS workspace right-click scope, pointer anchor and focus; matching ⋯ menu and existing sidebar layout retained");
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER);
        // herdr's order puts each workspace's agents in a card named for it; a row's dim line
        // leaves the workspace to the card, its tooltip and the list's label keep it
        assert.deepEqual(await page.locator(".agents-sidebar .agent-group-name").allTextContents(), ["checkout-api", "web-dashboard", "infra", "docs-site", "cli-tools"]);
        const apiRow = agent(page, API);
        // with nothing else to say, the line says the kind rather than stay empty
        const apiLine = await apiRow.locator(".agent-context").textContent() ?? "";
        assert.doesNotMatch(apiLine, /checkout-api/, "a row in a card leaves its workspace to the card");
        assert.match(apiLine, /claude/i, "a row in a card with nothing else to say names its kind");
        assert.match(await apiRow.locator(".agent-select").getAttribute("title") ?? "", /checkout-api/, "the tooltip still names the workspace");
        const labelledBy = await page.locator(".agents-sidebar .agent-group-rows", { has: page.locator(".agent-title", { hasText: API }) }).getAttribute("aria-labelledby");
        assert.equal(await page.locator(`[id="${labelledBy}"]`).textContent(), "checkout-api", "the card's rows are labelled by its head");
        await waitStatus(page, API, "done");
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER, "a finish does not move an agent");
        await agentSelect.click();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id === paneId, panes.api, { timeout: 5_000 });
        assert.equal(await agentSelect.getAttribute("aria-current"), "true", "ordinary click still selects the agent");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "selecting the agent does not open a menu");
        assert.equal(await agentStatus(page, API), "done", "herdr's DONE stands until herdr itself shows the pane");
      });
      console.log("PASS with Workspace cards on the Agents list keeps herdr's order in workspace cards, and an opened DONE keeps its dot");

      await withPage(browser, { agentCards: false, agentPins: false }, async (page) => {
        const selected = await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection"));
        const workspace = page.locator(".machine-workspaces .workspace-list:not(.sidebar-pinned) > .workspace-group > .workspace-header .workspace-select").first();
        const menu = page.getByRole("menu");
        await workspace.focus();
        await page.keyboard.press("Shift+F10");
        await menu.waitFor();
        assert.deepEqual(await menu.getByRole("menuitem").allTextContents(), ["Pin workspace", "Rename workspace", "Close workspace", "New worktree", "Open worktree…"], "the context-menu key and right-click have identical items");
        await page.keyboard.press("Escape");
        const pins = () => page.evaluate(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]") as string[]);
        // A workspace favorite adds a shortcut without removing its normal tree row.
        const workspaceTitles = () => page.locator(".machine-workspaces .workspace-name").allTextContents();
        const herdrOrder = await workspaceTitles();
        const infraWorkspace = page.locator(`.workspace-list:not(.sidebar-pinned) > .workspace-group > .workspace-header .workspace-select[data-pane="${panes.infra}"]`);
        await infraWorkspace.click({ button: "right" });
        const infraMenu = page.getByRole("menu");
        await infraMenu.getByRole("menuitem", { name: "Pin workspace", exact: true }).click();
        const pinnedWorkspaces = page.getByRole("list", { name: "Pinned", exact: true }).filter({ has: page.locator(".workspace-group") });
        await pinnedWorkspaces.waitFor();
        const infraName = await infraWorkspace.locator(".workspace-name").textContent();
        assert.deepEqual(await pinnedWorkspaces.locator(".workspace-name").allTextContents(), [infraName], "the pinned workspace stands in the card");
        assert.deepEqual(await workspaceTitles(), [infraName, ...herdrOrder], "the favorite duplicates the row without changing herdr's tree");
        // it is moved within its card (the pin order), not out of it: workspace-touch-reorder-demo-regression.ts
        assert.equal(await infraWorkspace.getAttribute("draggable"), "true", "a pinned workspace can be dragged within its card");
        assert.ok((await pins()).includes(`local:workspace:${await infraWorkspace.evaluate((row) => row.closest(".workspace-group")?.getAttribute("data-workspace"))}`), "the pin is saved with the agents'");
        await infraWorkspace.click({ button: "right" });
        await infraMenu.getByRole("menuitem", { name: "Unpin workspace", exact: true }).click();
        await pinnedWorkspaces.waitFor({ state: "detached" });
        assert.deepEqual(await workspaceTitles(), herdrOrder, "unpinned, it returns to herdr's order");
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        // pin an agent that is not first from its right-click menu: it moves to the top, and nothing is selected
        const infraSelect = agent(page, INFRA).locator(".agent-select");
        await page.locator(".header-more-button").focus();
        await infraSelect.click({ button: "right" });
        const agentMenu = page.getByRole("menu", { name: INFRA, exact: true });
        await agentMenu.waitFor();
        assert.deepEqual(await agentMenu.getByRole("menuitem").allTextContents(), ["Pin agent"], "an agent's right-click menu offers its pin");
        await agentMenu.getByRole("menuitem", { name: "Pin agent" }).click();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.infra}`);
        assert.deepEqual(await agentTitles(page), [INFRA, ...AGENTS_HERDR_ORDER.filter((title) => title !== INFRA)], "a pinned agent moves to the top, the rest keep herdr's order");
        assert.equal(await page.evaluate(() => sessionStorage.getItem("herdr-web-ui:selection")), selected, "pinning does not select the agent");
        assert.equal(await page.locator(".header-more-button").evaluate((button) => document.activeElement === button), true, "the menu hands focus back where it was");
        await page.reload();
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await agents(page).first().waitFor({ state: "attached" });
        assert.equal((await agentTitles(page))[0], INFRA, "the pin survives a reload");
        // the keyboard's context-menu key opens the same menu, now with Unpin
        await infraSelect.focus();
        await page.keyboard.press("Shift+F10");
        await agentMenu.waitFor();
        assert.deepEqual(await agentMenu.getByRole("menuitem").allTextContents(), ["Unpin agent"], "a pinned agent's menu offers Unpin");
        // the menu focuses its first item on the next frame: Enter goes to it once it has the focus
        await page.waitForFunction(() => document.activeElement?.textContent === "Unpin agent", undefined, { timeout: 5_000 });
        await page.keyboard.press("Enter");
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").length === 0);
        assert.deepEqual(await pins(), []);
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER, "unpin restores the source order");
        assert.equal(await infraSelect.evaluate((button) => document.activeElement === button), true, "focus returns to the row as it moves back");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "the menu closes after its item runs");
        // pinned, an agent stands first, in a list named Pinned under the Agents head alone
        await agentSelect.click({ button: "right" });
        const apiMenu = page.getByRole("menu", { name: API, exact: true });
        await apiMenu.waitFor();
        await apiMenu.getByRole("menuitem", { name: "Pin agent" }).click();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.api}`);
        assert.equal(await page.getByRole("list", { name: "Pinned", exact: true }).count(), 1, "the pinned list is named Pinned");
        assert.deepEqual(await page.locator(".agents-sidebar .agent-list-pinned .agent-title").allTextContents(), [API], "the pinned list holds the pinned agent");
        await agentSelect.click({ button: "right" });
        await apiMenu.getByRole("menuitem", { name: "Unpin agent" }).click();
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").length === 0);
        assert.equal(await page.locator(".agents-sidebar .agent-list-pinned").count(), 0, "the pinned list goes with the last pin");
        assert.deepEqual(await agentTitles(page), AGENTS_HERDR_ORDER);
        console.log("PASS workspace right-click scope, pointer anchor and focus; the context-menu key opens the same menu; a workspace pins into a card and returns to herdr's order; an agent pins and unpins from its right-click menu and the key");
      });

      await withPage(browser, { agentPins: true }, async (page) => {
        const drawerToggle = page.locator('button[aria-controls="workspace-drawer"]');
        await drawerToggle.tap();
        const agentToggle = page.locator(".agents-sidebar .agent-section-toggle");
        assert.equal(await agentToggle.getAttribute("aria-expanded"), "false", "the phone's Agents section still starts folded");
        await agentToggle.tap();
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        await agentSelect.waitFor();
        assert.equal(await agentRow.getByRole("button").count(), 3, "touch rows expose selection, optional star and menu controls");
        assert.equal(await agentRow.locator(".row-menu-toggle").count(), 1, "touch also exposes the pin action sheet");
        const pin = agentRow.getByRole("button", { name: `Pin agent: ${API} · checkout-api`, exact: true });
        await pin.tap();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.api}`);
        assert.equal(await pin.getAttribute("aria-pressed"), "true", "a tap pins the agent");
        await agentSelect.tap();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id === paneId, panes.api, { timeout: 5_000 });
        assert.equal(await agentSelect.getAttribute("aria-current"), "true", "a tap still selects the agent");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "a tap opens no agent action sheet");
        assert.equal(await drawerToggle.getAttribute("aria-expanded"), "false", "selecting an agent closes the phone drawer");
      }, undefined, true);
      console.log("PASS optional agent stars coexist with context menus; click and tap still select");

      await withPage(browser, {}, async (page) => {
        const drawerToggle = page.locator('button[aria-controls="workspace-drawer"]');
        await drawerToggle.tap();
        const agentToggle = page.locator(".agents-sidebar .agent-section-toggle");
        assert.equal(await agentToggle.getAttribute("aria-expanded"), "false", "the phone's Agents section still starts folded");
        await agentToggle.tap();
        const agentRow = agent(page, API);
        const agentSelect = agentRow.locator(".agent-select");
        await agentSelect.waitFor();
        // the ⋯ shows on touch, where a long press opens no menu: its sheet pins the agent
        const more = agentRow.getByRole("button", { name: `More for ${API}`, exact: true });
        assert.ok(await more.isVisible(), "the ⋯ is visible on touch");
        await more.tap();
        const sheet = page.getByRole("dialog", { name: API, exact: true });
        await sheet.waitFor();
        await sheet.getByRole("button", { name: "Pin agent" }).tap();
        await page.waitForFunction((key) => JSON.parse(localStorage.getItem("herdr-web-ui:sidebar-agent-pins") ?? "[]").includes(key), `local:${panes.api}`);
        await sheet.waitFor({ state: "detached" });
        assert.deepEqual(await page.locator(".agents-sidebar .agent-list-pinned .agent-title").allTextContents(), [API], "the pinned row stands in the pinned list");
        await agentSelect.tap();
        await page.waitForFunction((paneId) => JSON.parse(sessionStorage.getItem("herdr-web-ui:selection") ?? "{}").pane_id === paneId, panes.api, { timeout: 5_000 });
        assert.equal(await agentSelect.getAttribute("aria-current"), "true", "a tap still selects the agent");
        assert.equal(await page.locator(".row-menu, .row-sheet").count(), 0, "a tap opens no agent action sheet");
        assert.equal(await drawerToggle.getAttribute("aria-expanded"), "false", "selecting an agent closes the phone drawer");
      }, undefined, true);
      console.log("PASS on a phone the ⋯ pins an agent from its sheet; a tap on the row selects it and opens no menu");

      await withPage(browser, { agentOrder: "activity" }, async (page) => {
        assert.equal((await agentTitles(page))[0], WEB, "the blocked agent is pinned on top");
        assert.equal(await page.locator(".agents-sidebar .agent-group").count(), 0, "Activity mixes workspaces, so it draws no cards");
        assert.match(await agent(page, WEB).locator(".agent-context").textContent() ?? "", /web-dashboard/, "a row outside a card names its workspace");

        // the demo's Claude pane finishes out of sight: it rises under the blocked one, and keeps its dot
        await waitStatus(page, API, "done");
        await waitAgentAt(page, 1, API);

        // a message sent from an agent takes it to the top while it runs ...
        await agent(page, INFRA).locator(".agent-select").click();
        await page.locator(".composer-text").fill("Check the backup again");
        await page.locator(".composer-text").press("Enter");
        await waitStatus(page, INFRA, "working");
        await waitAgentAt(page, 1, INFRA);
        // ... and keeps it there when it finishes while another pane is open, with its dot
        await page.locator(".machine-workspaces .workspace-select", { hasText: "release" }).first().click();
        await waitStatus(page, INFRA, "done");
        assert.equal((await agentTitles(page))[1], INFRA, "the agent just worked in stays on top after it finishes");

        // opening it here leaves herdr's DONE as it is
        await agent(page, INFRA).locator(".agent-select").click();
        await waitStatus(page, INFRA, "idle");
        assert.equal(await workspaceStatus(page, "infra"), "idle", "its workspace row reads ready too");
        assert.equal(await agentStatus(page, API), "done", "a finish never opened keeps its dot");
        // the run starts from an empty record: the opened finish is in it at herdr's counter for that
        // finish (a look made at a stand-in is saved once a roster read brings the counter), the
        // unopened one is not
        const finishSeq = await page.evaluate(async (paneId) => {
          const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { agents: { pane_id: string; state_change_seq?: number }[] } };
          return snapshot.agents.find((entry) => entry.pane_id === paneId)?.state_change_seq;
        }, panes.infra);
        assert.ok(Number.isSafeInteger(finishSeq), `the finished agent carries a counter: ${finishSeq}`);
        await page.waitForFunction(([paneId, seq]) => (JSON.parse(localStorage.getItem("herdr-web-ui:seen:local") ?? "{}") as Record<string, number>)[paneId] === seq,
          [panes.infra, finishSeq!] as const, { timeout: 10_000 });
        const record = JSON.parse(await page.evaluate(() => localStorage.getItem("herdr-web-ui:seen:local") ?? "{}")) as Record<string, number>;
        assert.equal(record[panes.api], undefined, `the unopened finish is not recorded: ${JSON.stringify(record)}`);

        // a finish watched on screen stays quiet after another pane is opened before the roster
        // read brings herdr's counter for it (#529 review): the look follows the counter. Roster
        // reads are held for that window, so the statuses come by push alone, as they do between reads
        await page.evaluate(() => {
          const page = window as unknown as { holdRoster: boolean; releaseRoster: () => void };
          const inner = window.fetch.bind(window);
          const waiting: Array<() => void> = [];
          page.holdRoster = true;
          page.releaseRoster = () => { page.holdRoster = false; for (const resume of waiting.splice(0)) resume(); };
          window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (page.holdRoster && /\/api\/(machines|session)\b/.test(target)) await new Promise<void>((resume) => waiting.push(resume));
            return inner(input, init);
          }) as typeof fetch;
        });
        await page.locator(".composer-text").fill("And once more");
        await page.locator(".composer-text").press("Enter");
        await waitStatus(page, INFRA, "working");
        await waitStatus(page, INFRA, "idle");
        await page.locator(".machine-workspaces .workspace-select", { hasText: "release" }).first().click();
        // the held reads go through, and a visibility change asks for one more: herdr's counter arrives
        await page.evaluate(() => {
          (window as unknown as { releaseRoster: () => void }).releaseRoster();
          document.dispatchEvent(new Event("visibilitychange"));
        });
        for (const deadline = Date.now() + 2_000; Date.now() < deadline;) {
          assert.equal(await agentStatus(page, INFRA), "idle", "a finish watched on screen does not get its dot back");
          await page.waitForTimeout(100);
        }
      }, {});
      console.log("PASS Activity pins blocked and follows recency without cards; an opened DONE reads as ready in both lists, an unopened one keeps its dot");

      // the demo keeps its agent template after its last agent closes (#529 review): a workspace
      // made in an emptied demo still lists its agent with herdr's counter
      await withPage(browser, { agentOrder: "activity" }, async (page) => {
        const made = await page.evaluate(async () => {
          const post = (path: string, body: object) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const session = async () => (await (await fetch("/api/session")).json()).snapshot as { workspaces: { workspace_id: string }[]; agents: { pane_id: string; state_change_seq?: number }[] };
          for (const { workspace_id } of (await session()).workspaces) await post("/api/workspace/close", { workspace_id, close_group: true });
          const created = await (await post("/api/workspace/create", { cwd: "/home/demo/fresh", agent: { kind: "claude" } })).json() as { pane_id: string };
          return { created: created.pane_id, agents: (await session()).agents };
        });
        const entry = made.agents.find((candidate) => candidate.pane_id === made.created);
        assert.ok(entry && Number.isSafeInteger(entry.state_change_seq), `the new agent carries a counter: ${JSON.stringify(made)}`);
        await agent(page, "fresh").waitFor();
      });
      console.log("PASS a workspace made after the demo's last agent closed is listed with herdr's counter");
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  rmSync(app, { recursive: true, force: true });
}
