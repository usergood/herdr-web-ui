# Imported upstream release history

These are the original project’s release notes included by the upstream merge in 0.7.0.

### Upstream 0.4.11 - 2026-10-16

#### Fixed
- `/effort` in a Claude Code chat shows its card again with Claude Code 2.1.301, whose slider
  describes the level between the level names and the hint.
  ([#1200](https://github.com/devswha/herdr-web-ui/pull/1200) by @sergiorademacher)
- Claude's plan card finds the session's plan file again, with **View plan**, when recent Claude Code
  versions write large request lines to the transcript after the line that names it.
  ([#1198](https://github.com/devswha/herdr-web-ui/pull/1198) by @sergiorademacher)
- Codex's folder trust prompt gets its card again when its hint ends with `esc quit` instead of
  `esc back`, as it does when Codex starts in a folder it has not seen.
  ([#1195](https://github.com/devswha/herdr-web-ui/pull/1195) by @vibewriter-hand)
- Terminal text a program colors for the other background stays readable: under a light theme,
  Claude Code's white question titles and reply bullets no longer vanish into the background. Other
  colors too faint for the theme are darkened or lightened just enough to read, such as yellow on a
  light palette.
  ([#1171](https://github.com/devswha/herdr-web-ui/pull/1171) by @todor-a)
- A connection that opens and drops again no longer retries every quarter second: retries back off
  until it has stayed open for 10 seconds. Returning to the page still retries immediately.
  ([#1183](https://github.com/devswha/herdr-web-ui/pull/1183) by @philipprass-prog)

#### Maintenance
- The remote-PC runtime is now version 30: every saved PC asks for **Update bridge…** once.

### Upstream 0.4.10 - 2026-10-16

#### Changed
- On a phone or tablet, the chip above the message box that holds the prompt Claude Code suggests
  next is off by default. **Settings → Chat → Composer → Suggestion chip** turns it back on; the
  suggestion still shows grey in the empty message box. With a keyboard, Tab takes it as before.
  ([#1185](https://github.com/devswha/herdr-web-ui/pull/1185))

#### Maintenance
- The remote-PC runtime is now version 29: every saved PC asks for **Update bridge…** once.

### Upstream 0.4.9 - 2026-10-16

#### Added
- Mod+Shift+PageUp/PageDown page the current chat transcript or the terminal's native history, one
  line overlapping between pages. When herdr reports no native history, they send plain page keys to
  the running program, which sets its own page length.
  ([#811](https://github.com/devswha/herdr-web-ui/pull/811) by @kratam)
- **Settings → Phone & devices → Portal** gives this PC a public HTTPS address through
  [Portal](https://github.com/gosuda/portal-tunnel), with no account and no domain of your own.
  With Portal v2.6.1 or later installed, **Start** runs it on a relay you enter, dropping any
  `Tailscale-User-Login` header a visitor sends; it starts only with `HERDR_WEB_TOKEN` set. The
  address and its QR code show on every signed-in device, any device that can type into your
  terminals can stop it, and an address left on comes back when the app restarts.
  ([#746](https://github.com/devswha/herdr-web-ui/pull/746) by @rabbitson87)
- **Two tabs side by side** on a desktop, from different workspaces or PCs: drag a tab down out
  of its strip, or a sidebar row over the pane area, and drop it on the left or right half. A guide
  shows the two halves as soon as the drag starts and keeps its side steady at the centre; Escape
  or a drop elsewhere leaves everything as it was. Each half draws its tab at herdr's own layout,
  with its own tab strip and a bar with its lens and a close, and a tab is never shown in both
  halves. A press in a half makes it the one the header, the palette and the shortcuts act on.
  The split is kept across a reload, and a narrower window shows the active half alone. Drag
  guide by @flam-ing. ([#861](https://github.com/devswha/herdr-web-ui/pull/861) by @Yoonwoo-Ha)
- The file viewer and Markdown reader page offer **Show source**, highlighted source with
  CSS-counter line numbers, and **Copy file**, which selects the source when copying is unavailable.
  **Settings → Chat → File viewer** controls line wrapping and Markdown width; previews inherit
  the chat's font and, in the viewer, the opening pane's chat width.
  ([#429](https://github.com/devswha/herdr-web-ui/pull/429) by @aNNdii)
- A line over the panes says when the server can be reached from the network with no access
  token set and no device paired, and what to do about it. Nothing about who is let in changes:
  pairing a device or setting a token is still the owner's call.
  ([#698](https://github.com/devswha/herdr-web-ui/pull/698) by @pt-act)
- **Shared settings and pins.** The browsers of one server, a PC's and a phone's, keep the same
  pinned agents and the same settings that do not depend on the device: theme and colors, language,
  the sidebar's rows, order, cards and pins, chat and usage-meter choices. A
  change shows on the other open pages at once. Each device keeps its own terminal and chat font
  sizes, key bar, shortcuts, density, alerts, microphone, the lens panes open in and the like. Opening a page never
  overwrites anything: a server that holds no shared settings yet takes them from the first change,
  and the browser that shares first brings its pins along. A page that lost its connection catches up
  when it is back. A watching device follows the shared settings and cannot change them for everyone. ([#854](https://github.com/devswha/herdr-web-ui/pull/854))
- **Settings → Appearance → Agent logos: Color | Mono.** Mono draws the logos without color:
  Claude's in the text color without its orange tile, the other logos with brand colors in grey,
  so a sidebar where nearly every agent is the same one is not a column of colored tiles. Color,
  today's look, stays the default. ([#850](https://github.com/devswha/herdr-web-ui/pull/850) by @phirschybar)
- File paths in a tool call's command and output, and in a code block with no language (a log
  an agent pasted), open in the file viewer like the paths in its prose: a line such as
  `/tmp/shot/t0.png (1600, 1000) -> (1255, 960)` opens the picture, from a phone or another PC
  as well, since the server reads the file. An HTML file now shows as its page, with a switch to
  its source: its own script runs in a sandbox with no origin, storage or network (not the web
  either), and the pictures, stylesheet and script it takes from its own folder are put into it,
  so an agent's report with its screenshots draws whole. Files outside that folder, hidden ones such as `.env`,
  and anything of another kind than the tag asks for are never put in.
  ([#691](https://github.com/devswha/herdr-web-ui/pull/691) by @MovieHolic-Plex)
- PCs saved in herdr appear automatically. Connect once per PC to enable automatic reconnection;
  installing or starting a bridge still needs separate approval. Changing the address, port or
  session clears both permissions and cached panes.
  ([#606](https://github.com/devswha/herdr-web-ui/pull/606) by @sobir-git)
- Typing `/` after whitespace in a chat message offers Claude Code and Codex skills at the caret,
  using `$name` for Codex. Whole-message commands remain at the start; pi skill commands remain
  there because pi only expands them at the start
  ([#982](https://github.com/devswha/herdr-web-ui/pull/982) by @demrom).
- The strip under the message box names the workspace's branch at its right end, beside the
  folder, for a repository that has a worktree open (the branches the sidebar already shows).
  ([#991](https://github.com/devswha/herdr-web-ui/pull/991))
- That strip marks a linked worktree as one, beside its folder's name.
  ([#991](https://github.com/devswha/herdr-web-ui/pull/991))
- A workspace or a worktree is pinned from its row menu (Pin workspace / Unpin workspace): it stands
  first in its PC's list, in a card, with a pin after its name; a pinned repository's workspace brings
  its worktrees. Pins are shared with the other browsers of the server, as the agents' are.
  ([#1137](https://github.com/devswha/herdr-web-ui/pull/1137))
- The in-app alert has a close button, so it can be put away without a flick or a wait.
  ([#1129](https://github.com/devswha/herdr-web-ui/pull/1129))
- Settings -> Appearance -> Status indicators can draw the sidebar's and tabs' agent state marks as
  herdr's TUI does, its Dots or Symbols in its default theme's colors, with ready and unknown drawn
  too. Classic, the marks so far, stays the default.
  ([#1135](https://github.com/devswha/herdr-web-ui/pull/1135))
- New workspace **Browse** has a **New folder** button: name a folder, press Enter, and it is made
  inside the folder shown and opened, so **Start** uses it.
  ([#1169](https://github.com/devswha/herdr-web-ui/pull/1169))
- Mod+Shift+E focuses the selected pane's message box or terminal input, so an iPad with an
  external keyboard needs no tap before typing. It can be reassigned or turned off in
  Settings → Shortcuts ([#822](https://github.com/devswha/herdr-web-ui/pull/822) by @kratam).
- Settings → Shortcuts records chords with their exact modifiers, not only Mod+Shift: `⌘+PageUp`,
  `Ctrl+K` or `⌘+⌥+F` are kept as pressed. Chords the browser, the OS or text editing keep are
  refused; a plain Ctrl or Alt chord, which shells and agents use, is saved only after Save anyway.
  ([#1151](https://github.com/devswha/herdr-web-ui/pull/1151) by @kratam)
- Record also takes Home, End and the punctuation keys. A punctuation key is read by its position,
  so accented letters such as Hungarian É or German Ö can be bound on any keyboard layout. The row's
  list is unchanged.
  ([#1151](https://github.com/devswha/herdr-web-ui/pull/1151) by @kratam)
- **New tab**, **Split pane right** and **Split pane down** can take a Mod+Shift shortcut in
  **Settings → Shortcuts**. They have no default key, and the command palette shows the chosen one.
  ([#940](https://github.com/devswha/herdr-web-ui/pull/940) by @sergiorademacher)
- The chat box says when a draft hits the 20 000-character cap, and how many characters of a paste
  were left out, instead of silently stopping.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The context ring's opened label has a Compact button that sends `/compact` in one tap, shown only
  for agents that list the command.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A **Quote in message** button appears after you select text in the terminal and adds the
  selection to that pane's chat draft, headed by the pane name and line range. It only fills the
  draft; nothing is sent.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Skill names an agent writes in an answer (`/name`, or `$name` for Codex) show as chips, matched
  against the pane's own skill list, and copy as the raw text.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The diff viewer's header gains **Copy path** (the repository-relative path, with no patch
  needed), and the viewer and the Changes list draw placeholder rows while they load so the layout
  holds.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The command palette finds Settings pages and actions by related words (try "theme" or "font"),
  opens the page directly, and lists matches found only through such words after title matches.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- File rows in the Files dialog's Browse and Changes lists and in the folder browser show a glyph
  for the file's kind (code, JSON, config, image, archive, lockfile, ...) and mark a `.git` folder,
  so a list can be scanned at a glance.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- With Theme set to System, **Settings → Appearance** picks separate Light and Dark palettes and
  switches between them with the OS.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- **Settings → Shortcuts** records a binding by pressing it (Escape cancels; reserved, unbindable
  and already-assigned chords are refused on the row), and a search field filters the shortcut
  list.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Long native conversations mount a window of rows while keeping selected and focused
  rows available. Reading position survives older messages and streaming; expanded work
  and fetched full outputs survive scrolling away.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- **Files → Changes** lists what changed in the repository a pane sits in: the working tree, the
  index, or two commits named by hand, one row per file with git's status letter, the path (a
  rename's old path too) and its added and removed lines. A row opens the file's diff from
  `@pierre/diffs` as a bounded window of rows, unified or side by side (Settings → File viewer →
  Diff layout; a phone shows one column and says so), with old and new line numbers, the context
  around each change folded to a line or shown whole, the file itself one tap away on the PC that
  holds it, and the patch copied as git printed it. Binary, too-large, conflicted and vanished
  changes, a folder outside git and a commit that does not exist each say what they are. Back,
  Escape and Close each close the diff alone and return the focus to its row; a remote PC's
  repository reads through its bridge; the demo answers from its fixture.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The file viewer opens a source file whole up to 8 MB and 200 000 lines (a Markdown file keeps
  its 256 KB Preview), and draws a source of more than 2 000 lines as a window of rows from
  `@pierre/diffs`, so a 120 000-line file scrolls with a few hundred rows in the page. Up to
  256 KB and 5 000 lines the rows are colored in the package's own worker; a longer source stays
  plain and says so. A line reference reveals its line against the mounted row, on a phone with
  wrapping too; a cut file says whether its bytes or its lines ended it; and Copy, without a
  clipboard, shows the whole source as a selected text box.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- File links with `:line[:column]` or `#Lline[-Lline]` open the source at the first
  requested line, including Markdown reader tabs. Lines outside the bounded preview
  are explained rather than silently opening at the top.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The command palette browses folders: type a path such as `~/` (or pick **Browse folders**) to walk
  the PC's folders, jump to the folder of a pinned agent or a recent folder, and open the one you
  reach in Files. The Files dialog has a button that opens the palette already browsing its current
  folder.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- In Settings, the Chat font and Terminal font fields can be picked from a searchable, previewed list of
  the fonts installed on this device in Chromium browsers, and the terminal refuses proportional
  fonts.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- **Settings → Appearance → Typography** sets the interface font size on this device, apart from the
  terminal's and the chat's own.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Coming back to a pane's chat puts you on the same turn and offset you left, or at the end if you
  were following it; the place is remembered per pane and PC for the life of the tab.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A conversation of four or more turns shows a rail of short dashes left of the chat, one per
  message you sent with the one in view marked; click a dash, or focus it and press Enter, to jump
  to that turn. It is hidden on a phone and wherever the chat column leaves no margin.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A terminal scrolled up into herdr's history now shows a round "Jump to bottom" button at the
  grid's bottom-right corner. Tapping it returns the pane to the live bottom without taking focus
  from the terminal or its on-screen keyboard.
  ([#1036](https://github.com/devswha/herdr-web-ui/pull/1036) by @m16khb)
- **Remote PCs from a Windows connection server**: the web UI running on Windows x64 now
  connects to other PCs with Windows' own OpenSSH and `ssh-agent`, including the machines saved
  in herdr. A key loaded with `ssh-add` signs without a prompt; otherwise the passphrase or
  password is asked once per connection. An unknown host's fingerprint is shown before anything
  authenticates, and a key path such as `C:\Users\you\.ssh\id_ed25519` is accepted. A host whose
  SSH config adds its own port forwards is refused on Windows, with that reason, and a host that
  asks for a password only through keyboard-interactive needs a key in `ssh-agent` there.
  ([#914](https://github.com/devswha/herdr-web-ui/pull/914) by @Galtozzy)

#### Changed
- Install and update counts include app setting values such as theme, text size and notification
  choices, rather than only the names of changed appearance settings. Custom text and account
  identifiers stay out; custom choices use flags or counts. The expanded notice is shown again
  before sending, and existing opt-outs and install/update-only delivery stay unchanged.
  ([#866](https://github.com/devswha/herdr-web-ui/pull/866))
- Markdown file previews are parsed in a worker with a 2 s budget and a 60 000-element limit,
  keeping the existing HTML blocks, images and reader-page navigation. A preview that cannot
  be drawn offers its source. Partial text and preview, highlighting or line-number limits are
  reported beside the file size with a warning icon and tooltip. **Open in a new tab**,
  **Open raw file** and **Download** retain their existing destinations without a duplicate Raw action.
  ([#429](https://github.com/devswha/herdr-web-ui/pull/429) by @aNNdii)
- The sidebar's RUN mark is a working-colored dot that breathes, as T3 Code's does, instead of a
  spinning arc that read as flicker beside the rows: it holds full most of a 2-second cycle and
  dims to half in a few steps, and every running row breathes in step. BG is a still ring in the
  same color, so the two read apart without motion; it breathes under reduced motion too.
  ([#860](https://github.com/devswha/herdr-web-ui/pull/860))
- The agent list in New workspace, New tab and New worktree offers only the agents this app supports
  (the Supported agents table of the guide) and that PC has installed, instead of every agent herdr
  has a manifest for. Any other program still starts from a pane's shell.
  ([#994](https://github.com/devswha/herdr-web-ui/pull/994))
- An agent in the Agents list is pinned from its `⋯` menu or a right-click (Pin agent / Unpin
  agent) instead of a star beside it; pinned agents stand first in a card, each marked with a pin. Pins work
  without a setting, and pins saved before stay.
  ([#1120](https://github.com/devswha/herdr-web-ui/pull/1120))
- The header menu's Alerts row shows a check mark while alerts are on, so it reads as the switch it
  is instead of a link to Settings.
  ([#1000](https://github.com/devswha/herdr-web-ui/pull/1000))
- A file up to 32 MB can be attached in the composer (it was 8 MB).
  ([#1071](https://github.com/devswha/herdr-web-ui/pull/1071))
- The chat message box and a queued message's text now take a phone keyboard's autocorrect,
  suggestions and sentence capitals. The terminal input line keeps them off.
  ([#1111](https://github.com/devswha/herdr-web-ui/pull/1111))
- When a chat message is refused because Claude Code's input box in the terminal may not be empty,
  and no draft can be named, the note shows what the box holds and offers **Send anyway**, which
  sends that message once into the same Claude terminal.
  ([#1066](https://github.com/devswha/herdr-web-ui/pull/1066))
- A Codex pane's row and header show its thread's title alone. Codex adds the project folder
  after it ("Respond to greeting | my-worktree..."), which the row already says underneath.
  Alerts keep the whole title: they are read away from the row.
  ([#989](https://github.com/devswha/herdr-web-ui/pull/989))
- A phone no longer draws the folder and branch strip under the message box, which took room from
  the conversation; a desktop still shows it.
  ([#1127](https://github.com/devswha/herdr-web-ui/pull/1127))
- In a linked worktree the strip under the message box names the repository instead of the
  checkout folder, which only repeated the branch at its other end.
  ([#1033](https://github.com/devswha/herdr-web-ui/pull/1033))
- On a desktop, workspace, worktree and agent rows no longer show a `⋯` button: a right-click or the
  context-menu key opens the row's menu. Touch screens and narrow windows keep the `⋯`.
  ([#1137](https://github.com/devswha/herdr-web-ui/pull/1137))
- On a phone the key bar's keyboard button is now the input line's switch: it is lit while the
  input line is shown and unlit in direct typing (it used to be the other way round), and screen
  readers name it "Input line".
  ([#1175](https://github.com/devswha/herdr-web-ui/pull/1175))
- The app's first script is about 42 KB smaller (gzip): the chat timeline and its list library
  load as their own file beside it, instead of inside it.
  ([#977](https://github.com/devswha/herdr-web-ui/pull/977))
- An OmO pane whose turn ended while background tasks it started still run reads BG instead of
  DONE, as a Claude pane does, for as long as a task runs, and its finish is alerted once that
  work is over.
  ([#1138](https://github.com/devswha/herdr-web-ui/pull/1138))
- On a phone the terminal now starts in direct typing, like a desktop: keys go straight into the
  pane. The key bar's keyboard button, or Settings → Terminal → Terminal input mode, still switches
  to the input line, and that choice is remembered on the device. The setting now offers Direct
  typing and Input line; Automatic, which became the same as Direct typing, is gone.
  ([#1163](https://github.com/devswha/herdr-web-ui/pull/1163))
- On touch screens, Settings → Chat → Composer labels the existing Return choice as "Return inserts a new line" and explains sending with Send or a hardware keyboard. The default still sends with Return.
  ([#986](https://github.com/devswha/herdr-web-ui/pull/986) by @demrom)
- Sign out moved from the header and the command palette to Settings → Devices, and asks once
  before it signs this browser out, since getting back in takes the token or a pairing code.
  ([#1128](https://github.com/devswha/herdr-web-ui/pull/1128))
- The split view's halves are independent: a pick in the sidebar opens in the active half and never
  moves the focus to the other half or trades the halves, and both halves may show the same tab.
  An Agents row, a pane's title and a half's bar can be dragged to a half, as a workspace row or a
  tab already could.
  ([#1176](https://github.com/devswha/herdr-web-ui/pull/1176))
- App, site and demo builds run Vite 8 on Bun rather than the first Node on PATH,
  while type checking uses TypeScript 7. The terminal sidecar still supports Node 18,
  and the client keeps its previous browser syntax targets.
  ([#830](https://github.com/devswha/herdr-web-ui/pull/830) by @todor-a)
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The browser client uses React 19.3, with native inert handling for offline
  workspaces and nullable refs for the settings and tab controls.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Chat turn times now tell yesterday and older turns apart ("yesterday at 04:45 PM", "9/23 02:30
  PM") and show the full date and time on hover or focus.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Chat glides to new output while an agent works and you follow the end, instead of snapping to it;
  reduced motion keeps the instant scroll.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A Markdown image on a line of its own holds a 16:9 slot until it decodes and keeps it with an
  "Image unavailable" note if it cannot, so a document moves at most once per picture; chat
  thumbnails keep their box through loading and failure the same way.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A work block opens and folds at its measured height: the rows slide out from under the header and
  back, a row opened inside it grows it at the same pace, and the reader's scroll position holds
  through both; reduced motion snaps it.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The file browser shows folders relative to the pane's own directory (`herdr/src/components`)
  instead of from `~/`; folders outside it keep the `~/` form.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Keep the selected `/` command or `@` file completion highlighted in the composer when matching
  results refresh for the same query.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- The phone keyboard viewport resyncs when the page becomes visible or is restored.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Composer attachments with an empty or generic browser MIME type infer their image preview and
  upload type from a PNG, JPEG, GIF or WebP filename extension.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Under the chat lens, connection and input notices (another app holding the pane, a failed output
  stream, input held for the terminal, a copy note) stand as rows over the input card instead of
  floating top-right, each dismissible with an X; a dismissed notice returns when it changes or
  recurs. A notice holding input typed while disconnected cannot be dismissed, so Send and Discard
  stay reachable.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- **Files → Changes** lists the changed files under their folders: a folder sits where its first
  file was listed with its file count, a lone chain of folders is one row, a tap folds a folder, and
  a button beside Refresh folds or opens them all.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Reopening a diff or a long file is faster: the syntax-highlight workers are shared across the app
  and stay warm for 30 s after the last viewer closes, and a theme switch no longer restarts them.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Workspace rows in the sidebar show the project's own favicon, when its folder has one, instead of
  the plain folder glyph.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Chat images open in a full-screen viewer with the message's other images a step away,
  pointer-anchored zoom and pan, and Copy image and Download actions, instead of a new tab.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Copying a chat selection keeps Markdown lists, code and image links, with sanitized rich HTML for
  pasting into documents; code-only selections stay plain code.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A slim strip tucked under the chat composer's card, as t3code's, can name the pane's working
  folder and branch.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A long user message folds to twelve lines behind **Show full message** (**Show less** folds it
  again), and keeps that choice while the chat scrolls.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A work row now says what the agent said the call is for (OmO's eval summary, the description
  Claude gives a Bash command or a subagent) instead of the tool id or the raw command, which stays
  in the opened row and its tooltip. Opening a tool's whole output keeps its work row in place.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Switching back to one of the last few tabs shows its terminal and chat at once instead of
  rebuilding them: their panes stay mounted while hidden, attached terminals let go of the pty,
  and attach again on return. Mirrored panes and the embedded demo keep their subscriptions.
  ([#1061](https://github.com/devswha/herdr-web-ui/pull/1061))
- A chat opened again draws the conversation it last read straight away and checks for news in
  the background, instead of showing "Loading conversation…" first, and it reads once per
  switch instead of twice.
  ([#1061](https://github.com/devswha/herdr-web-ui/pull/1061))
- Hidden chats, including split siblings on a phone, pause conversation watches and optional
  terminal-output reads until they are shown again.
  ([#1061](https://github.com/devswha/herdr-web-ui/pull/1061))
- Hide the network exposure notice and startup warning when the server binds only to a
  Tailscale address. LAN and wildcard binds still warn; access and authentication stay unchanged.
  ([#1124](https://github.com/devswha/herdr-web-ui/pull/1124))
- Anonymous usage counts now also report the light and dark palettes System mode switches between,
  the interface font size, the diff layout and whether the usage meters' accounts were ever
  reordered (a yes or no, never the accounts), and no longer report the settings removed in this
  release.
  ([#1105](https://github.com/devswha/herdr-web-ui/pull/1105))
- The line about anonymous install and update counts is one short sentence on one row. Its Turn off
  button is gone: What is sent opens Settings → About, where the switch is.
  ([#995](https://github.com/devswha/herdr-web-ui/pull/995))
- The pane header's `⋯` stays visible on touch screens and appears on keyboard focus on desktop;
  tab to it and press Enter, or right-click the pane with a mouse. Shift+F10 in the terminal
  stays with the terminal program.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- The tab's `⋯` on touch screens no longer lists New tab (the strip's `+` sits beside it).
  At widths that show one pane at a time, it omits Split right, Split down and Zoom pane, but
  keeps Unzoom pane so other panes remain reachable. Wider touch screens keep split and zoom.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))

#### Removed
- Settings → Appearance no longer has Workspace cards, Pin agents or Quiet opened finishes. The
  Agents list is always flat, and a finished agent keeps herdr's DONE until herdr shows it.
  ([#1120](https://github.com/devswha/herdr-web-ui/pull/1120))
- The Turkish UI language and the Turkish README. A browser set to Turkish now shows English, and
  a device that chose Turkish in Settings goes back to following the browser.
  ([#1081](https://github.com/devswha/herdr-web-ui/pull/1081))
- The terminal no longer draws a history scrollbar beside the grid, on desktop or phone, and the
  grid takes the column it reserved. Wheel, touch drag, Mod+Shift+PageUp/PageDown and Find still
  scroll herdr's history.
  ([#1113](https://github.com/devswha/herdr-web-ui/pull/1113))
- The Dark report, Lilac and Forest color palettes. Settings that chose one of them now open in
  Amber; Amber, Charcoal and Catppuccin remain.
  ([#1078](https://github.com/devswha/herdr-web-ui/pull/1078))
- **Move pane to…** in the header's More menu, and `POST /api/pane/move` behind it. Move a pane
  in herdr's TUI; the app follows the roster as before.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- **Send right-clicks to pane** in the pane menu: a right-click on a pane always opens its menu.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- **New tab** in the header's More menu: the tab strip's `+` and the command palette open one.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- **Command palette** in a phone's More menu and **Browse folders in the palette** in its Files
  dialog. The command palette and its plugin actions are not available in the phone touch UI;
  use a wider screen or an external keyboard's Mod+Shift+K shortcut.
  ([#1101](https://github.com/devswha/herdr-web-ui/pull/1101))
- Four more settings: Page overlap (one line stays between pages), Files at once (one paste, pick
  or drop takes up to 100 files), Highlight code (always on) and PageUp / PageDown scroll chat
  (plain page keys now always scroll the chat transcript, also while typing; in the terminal they
  still go to the running program).
  ([#1104](https://github.com/devswha/herdr-web-ui/pull/1104))
- Five settings, each now fixed at what most devices already used: Show pace for the plan meters
  (off), the Suggestion chip switch (always shown), Fit 80 columns in a split pane (always on), and
  the terminal's Cursor shape and Blinking cursor (a blinking block). A program in a pane can still
  change its cursor.
  ([#1099](https://github.com/devswha/herdr-web-ui/pull/1099))

#### Fixed
- Open terminals reconnect automatically after herdr restarts or updates, without switching
  panes or reloading the browser, and clear the stale terminal-ended notice.
- First-device pairing waits for the browser to return its device cookie before restricting
  access. A proxy that drops the cookie no longer locks out an otherwise open installation;
  Settings reports the failed pairing instead. Already restricted installations stay restricted.
  ([#915](https://github.com/devswha/herdr-web-ui/pull/915))
- A message another Claude Code session sends into a pane (its `peer` messages) shows in the chat as
  a folded **Message from another session: {name}** that opens its own turn, instead of being skipped so the work it
  started was appended to the answer before it.
  ([#870](https://github.com/devswha/herdr-web-ui/pull/870) by @Noobear)
- Attached files upload three at a time instead of one after another, and each file's `@path` goes
  to the start of the message in the order the files were picked, once a `/command` being typed or
  an IME composition is finished. It used to go where the caret
  was, so a path that arrived while you typed landed in the middle of your words and moved the caret.
  ([#864](https://github.com/devswha/herdr-web-ui/pull/864) by @demrom)
- A Pi conversation whose session file has grown past 64 MiB reads as a conversation again, where
  the chat fell back to the terminal's text (`branch_unreadable`): the reader no longer refuses a
  long active branch as a whole, and pages it the way it pages a short one, within the same budgets.
  ([#869](https://github.com/devswha/herdr-web-ui/pull/869) by @Noobear)
- One paste, pick or drop attaches up to 100 files instead of silently keeping the first four, and
  the message box says how many it left out.
  ([#863](https://github.com/devswha/herdr-web-ui/pull/863) by @demrom)
- Web UI SSH connections no longer open extra tunnels configured in the account’s SSH config.
  ([#606](https://github.com/devswha/herdr-web-ui/pull/606) by @sobir-git)
- **Send now** on a working Codex pane sends the message at once. Codex kept it until its next
  tool call; once Codex shows that very message waiting, Send now presses Escape, which Codex
  itself offers to interrupt the turn and send it. An ordinary Send and the automatic next-turn
  delivery never interrupt Codex.
  ([#783](https://github.com/devswha/herdr-web-ui/pull/783) by @kilhyeonjun)
- On Windows, a pane that runs a launcher which starts OmO as its child is recognized as OmO. herdr
  names only the launcher there, so the bridge now also looks for OmO below the pane's shell in the
  PC's process table, so its chat and session are found. Only processes below that pane's own
  shell count. ([#886](https://github.com/devswha/herdr-web-ui/pull/886) by @willowite)
- The **agent picker** in the New workspace and New worktree dialogs no longer closes when an
  unrelated element scrolls, such as a text field scrolling its own text. It closes when the
  window resizes or when something that holds it scrolls. Moving through a long list with the
  arrow keys scrolls only the list, so the dialog no longer moves and closes the picker.
  ([#1010](https://github.com/devswha/herdr-web-ui/pull/1010),
  [#889](https://github.com/devswha/herdr-web-ui/pull/889) by @willowite)
- Android Chrome's soft keyboard no longer resizes the shared terminal when it also shrinks the
  layout viewport and the large viewport ruler.
  ([#1087](https://github.com/devswha/herdr-web-ui/pull/1087))
- A pane another web bridge holds no longer unlocks its input for a moment and shows the "held"
  notice twice when a busy herdr writes its refusal a little after the attach's teardown.
  ([#979](https://github.com/devswha/herdr-web-ui/pull/979))
- A terminal whose herdr the server cannot start (not on the server's PATH, or `HERDR_WEB_HERDR_BIN`
  naming no executable) now says so and the server logs it, instead of waiting for input forever.
  ([#1012](https://github.com/devswha/herdr-web-ui/pull/1012))
- With herdr 0.9.4 or later, opening a terminal on a second device no longer types stray
  characters such as `1016;2$y1;2c` into the pane, and a terminal is no longer reported ready
  before its attach has settled: the app answers herdr's attach-time terminal queries itself
  instead of replaying them to every browser.
  ([#1165](https://github.com/devswha/herdr-web-ui/pull/1165))
- A file picked in the browser over the attachment limit is refused with the size message
  before it is uploaded, rather than ending in a blank 413 the browser cannot explain.
  ([#1071](https://github.com/devswha/herdr-web-ui/pull/1071))
- Shared authentication failure bookkeeping stays bounded as forwarded client addresses rotate.
  ([#1059](https://github.com/devswha/herdr-web-ui/pull/1059))
- Chat no longer leaves a growing blank space under the last message, which could stay until the
  chat was reopened: the list's brief end padding was never removed on screens where it fell between
  pixels.
  ([#1030](https://github.com/devswha/herdr-web-ui/pull/1030))
- PageUp in the chat view no longer snaps back to the latest message when it is pressed right
  after the view resized or new output arrived: a follow-the-end scroll still waiting in the
  message list is dropped when the reader pages away.
  ([#985](https://github.com/devswha/herdr-web-ui/pull/985))
- Chat and conversation history reads no longer lose their HTTP connection after ten seconds while the bridge is still waiting for valid herdr replies.
  ([#1023](https://github.com/devswha/herdr-web-ui/pull/1023) by @demrom)
- Selecting text in a chat reply keeps inline file paths on the clipboard, including code links on touch screens.
  ([#1077](https://github.com/devswha/herdr-web-ui/pull/1077) by @demrom)
- Chat Send no longer does nothing when tapped on a phone while the keyboard is still composing
  the last word or syllable (Gboard, Korean, Japanese and Chinese keyboards): the tap finishes the
  word and sends the message, and says "Finish the word, then send." when the keyboard does not
  commit it.
  ([#1142](https://github.com/devswha/herdr-web-ui/pull/1142))
- A chat message sent to an OmO pane while it works is no longer refused as "Claude Code's input box
  is not empty": the input box under OmO's status rule (`── • Running …`) is read again.
  ([#1066](https://github.com/devswha/herdr-web-ui/pull/1066))
- **Send in the chat keeps the keyboard up on a phone.** Pressing it used to take focus from the
  message box, which closed the keyboard and moved the button before the tap landed, so the message
  was not sent. ([#937](https://github.com/devswha/herdr-web-ui/pull/937) by @lunchyfox)
- Keep completed Claude replies in separate chat messages when background notifications or hooks resume the agent without a new user prompt.
  ([#1024](https://github.com/devswha/herdr-web-ui/pull/1024) by @demrom)
- Chat sends to Claude Code started with `NO_COLOR` are no longer refused because its empty-prompt
  tip (`Try "…"`) was read as text typed in the terminal, and "Clear it and send" no longer fails
  on it.
  ([#1014](https://github.com/devswha/herdr-web-ui/pull/1014))
- Claude's plan card shows the whole plan, not only the part that fits the pane: the text comes
  from Claude's plan file (`<config dir>/plans/<slug>.md`), and **View plan** opens that file in the
  file viewer as Markdown. A session without a plan file shows the screen's text, as before.
  ([#855](https://github.com/devswha/herdr-web-ui/pull/855) by @sergiorademacher)
- Chat no longer stays empty after `/resume` of a Claude Code session that runs in the background:
  it follows the job the command names to that job's own transcript.
  ([#1057](https://github.com/devswha/herdr-web-ui/pull/1057))
- Claude's "Review your answers" screen after a multi-question ask gets its Submit/Cancel card again in a
  named session and when the review is taller than the pane, so answers given in the chat can be sent.
  ([#1133](https://github.com/devswha/herdr-web-ui/pull/1133) by @willowite)
- A file link a Claude Code pane names relative to its own scratch folder (`scratchpad/draft.md`)
  now opens: when the pane's folder has no such file, the viewer looks in that Claude session's
  temp folder.
  ([#1134](https://github.com/devswha/herdr-web-ui/pull/1134))
- Chat shows the progress messages a recent Claude Code prints between its tool calls. Claude Code
  records them as thinking, so they were hidden unless Show thinking was on.
  ([#1029](https://github.com/devswha/herdr-web-ui/pull/1029))
- The Close workspace confirmation reads "1 pane closes with it, and the agent in it stops." for a
  workspace with one pane, and counts one worktree workspace in the singular too.
  ([#998](https://github.com/devswha/herdr-web-ui/pull/998))
- A closed workspace leaves the sidebar as soon as herdr closes it, about half a second sooner:
  its panes send no exit, so browsers used to learn of it only after the next roster refresh.
  Removing a worktree does the same. ([#1017](https://github.com/devswha/herdr-web-ui/pull/1017), [#944](https://github.com/devswha/herdr-web-ui/pull/944) by @todor-a)
- Codex Chat recognizes short first answers and prompts preceded by model, command, or
  working-directory notices while retaining exact prompt and conversation ownership checks.
  ([#1075](https://github.com/devswha/herdr-web-ui/pull/1075))
- A file whose `@path` has no room in a message near 20,000 characters says so: its tile reads
  "No room" and the status line says how many characters to remove. Removing that file lets the
  files picked after it in. Within 200 characters of the limit the status line counts what is left.
  ([#872](https://github.com/devswha/herdr-web-ui/pull/872) by @demrom)
- Chat Send now shows a progress ring while the pane acknowledges the message, keeping the draft visible until it is accepted.
  ([#1025](https://github.com/devswha/herdr-web-ui/pull/1025) by @demrom)
- The Send action keeps its accessible name while busy; its description reports that the message is sending.
  ([#1025](https://github.com/devswha/herdr-web-ui/pull/1025) by @demrom)
- Keep a typed chat draft stable when agent prompt suggestions and streaming status metadata update.
  ([#1056](https://github.com/devswha/herdr-web-ui/pull/1056) by @demrom)
- On a desktop, a password prompt in the terminal no longer blocks typing into the grid: the
  password goes straight to the program, as in any terminal, while the masked input stays as an
  option for a phone. Offline, or while input is held for review, a password keystroke is refused
  with a note instead of being kept in a draft.
  ([#1067](https://github.com/devswha/herdr-web-ui/pull/1067))
- On a phone, switching between Chat and Terminal from the header closes the workspace list, so it
  no longer stays open over the view just picked.
  ([#999](https://github.com/devswha/herdr-web-ui/pull/999))
- On a phone, Escape now closes the open workspace list instead of typing `^[` into the terminal
  behind it or doing nothing.
  ([#1013](https://github.com/devswha/herdr-web-ui/pull/1013))
- An agent started from New workspace, New tab or New worktree opens its chat on the greeting over
  the message box. Codex, Claude Code, OpenCode, gjc and Grok write no session before the first
  message, so their chat said "Conversation unavailable" until then. A worktree's agent also opens
  in the same lens a new workspace's does.
  ([#990](https://github.com/devswha/herdr-web-ui/pull/990))
- The message box of a chat not begun names the model, read from the agent's own start screen:
  Claude Code's model, and the model and reasoning effort of Codex and gjc. It was blank until the
  first message wrote a transcript.
  ([#990](https://github.com/devswha/herdr-web-ui/pull/990))
- An agent started from the app reads READY until its first turn. Codex drawing its start screen
  read as working and then DONE, on a pane nobody had asked anything of.
  ([#990](https://github.com/devswha/herdr-web-ui/pull/990))
- Several devices or polls reading one GJC chat at the same moment now share a single lookup
  instead of each starting the GJC CLI (about 0.7 s apiece).
  ([#1058](https://github.com/devswha/herdr-web-ui/pull/1058))
- A Gajae Code pane's status now comes from gjc's own session transcript instead of what herdr
  reports for the pane, which could keep a finished turn at RUN for work a provider child was
  still doing — and a turn gjc ran while the child was quiet never read RUN or sent a done
  alert. A turn that ended in an error or was aborted reads READY rather than DONE, a
  background job's result that wakes the agent reads RUN, and a pane whose transcript cannot
  be told keeps herdr's status.
  ([#928](https://github.com/devswha/herdr-web-ui/pull/928) by @Haeminway1)
- Gajae Code question cards no longer refuse an answer as stale when the transcript or status
  above the question dialog redraws. The dialog's question, details and choices still have to match
  before the answer is confirmed.
  ([#1020](https://github.com/devswha/herdr-web-ui/pull/1020),
  [#997](https://github.com/devswha/herdr-web-ui/pull/997) by @yuseongkim-inbl)
- GJC chat identifies its session through GJC's SDK broker instead of matching terminal
  answers or session titles. Copied output from another session can no longer select that
  session's conversation. This requires GJC 0.18.9 or later for its broker-bound SDK
  session CLI; an older GJC, or an unavailable or ambiguous SDK identity, uses Terminal instead.
  ([#912](https://github.com/devswha/herdr-web-ui/pull/912))
- Input held while the terminal is not ready now follows the Backspace key, so text erased with it
  is not sent, and erasing all of it clears the notice. An Enter between typed text or a multi-line
  paste keeps its text with a space where the line break was, and the held-input notice says the
  break was left out instead of dropping the paste in silence; Send still never presses Enter. A
  paste with other control characters is told as left out, the notice no longer blames length for
  it, and neither an Enter with nothing held nor a Shift+Enter leaves a notice.
  ([#956](https://github.com/devswha/herdr-web-ui/pull/956))
- A chat message to Hermes no longer joins text already typed into Hermes' input in the terminal,
  where the paste and its Enter sent both as one message. As with Claude Code, a send or a held
  message's delivery is refused while that input holds anything but Hermes' own hint, and the chat
  says so ([#1149](https://github.com/devswha/herdr-web-ui/pull/1149),
  [#859](https://github.com/devswha/herdr-web-ui/pull/859) by @RikiSanjayaa).
- **Stop** in a Hermes pane's chat interrupts the running turn: it sends Hermes one Ctrl+C, the key
  Hermes interrupts with, instead of an Escape Hermes ignores. It does so only while Hermes' own input
  row shows a running turn, and once per turn, since Ctrl+C quits an idle Hermes and a second one
  force-quits it ([#856](https://github.com/devswha/herdr-web-ui/issues/856),
  [#859](https://github.com/devswha/herdr-web-ui/pull/859) by @RikiSanjayaa). Text typed into Hermes' input
  that quotes its busy hint is not taken for a running turn.
  ([#1148](https://github.com/devswha/herdr-web-ui/pull/1148), [#1161](https://github.com/devswha/herdr-web-ui/pull/1161))
- The terminal's input line no longer resizes the pane while it grows to more rows, shows a note
  or collapses after Send: it now floats over the terminal's last rows, and so does the masked
  password input, so the pane keeps its size for every device on it. In a short pane both stop at
  the terminal's top and scroll, and switching lenses keeps what was typed in the masked input.
  ([#966](https://github.com/devswha/herdr-web-ui/pull/966))
- A bridge install that was cut off mid-upload no longer blocks later updates with "Another
  installation is in progress": a stale `install.lock` is reclaimed, and the upload is bounded
  ([#895](https://github.com/devswha/herdr-web-ui/pull/895) by @suho-han).
- The Windows installer assigns `gh` to a job before allowing a shim to start a child that keeps
  its output open: the job ends with the call, and its output pipes are closed. If Windows refuses
  job assignment, the existing launcher-based cleanup remains, without guaranteeing orphan cleanup.
  ([#1073](https://github.com/devswha/herdr-web-ui/pull/1073))
- Korean typed on an iPad with a hardware keyboard (Magic Keyboard) reaches the terminal as whole
  syllables again. iPadOS Safari sent each jamo as its own key, so 한 arrived as ㅎㅏㄴ; the
  terminal now lets the iPad compose the syllable and sends it once, before the next key.
  ([#938](https://github.com/devswha/herdr-web-ui/pull/938) by @Noobear)
- The syllable being typed in the terminal is drawn at the size of the ones already typed. On Apple
  devices the terminal enlarges Hangul to fill its two cells, but the box that shows the pending
  syllable kept the plain size, so the last syllable looked smaller until it was committed.
  ([#938](https://github.com/devswha/herdr-web-ui/pull/938) by @Noobear)
- A visible desktop terminal keeps its grid when its window loses focus, so returning to
  Chat on a phone restores the desktop width without requiring another click or refocus.
  ([#1095](https://github.com/devswha/herdr-web-ui/pull/1095))
- On a phone, the key bar no longer goes grey while a word is still being typed in the input line:
  Esc, ^C, the arrows and Ctrl/Alt/Shift work mid-word with Gboard or a Korean or Japanese keyboard.
  Only the switch to direct typing waits until the word is finished.
  ([#962](https://github.com/devswha/herdr-web-ui/pull/962))
- The terminal's key bar no longer sits against the pane's left edge, and on an iPad or phone only
  the bar at the bottom of the screen keeps room for the home indicator: a pane stacked over
  another one no longer has empty space under its keys.
  ([#943](https://github.com/devswha/herdr-web-ui/pull/943) by @Noobear)
- A workspace or tab with two panes opens again on the pane you last looked at in this browser,
  also after the page reloads (a phone that dropped the app in the background, or an update),
  instead of the pane herdr's own window has in front.
  ([#1150](https://github.com/devswha/herdr-web-ui/pull/1150))
- A phone on a weak mobile link that opens a busy pane another tab already shows is no longer cut
  off with "Terminal output stopped because this device could not keep up." while it is still
  receiving the pane's recent output, and it no longer freezes that pane's output in the other tab
  meanwhile. A device is now stopped when it has acknowledged nothing for 2 seconds (longer while
  a large chunk of output is still on its way to it), or has held the pane's output paused for 10
  seconds. A quiet split pane is no longer frozen or cut off because the pane next to it is busy.
  A device joining a busy pane now gets its last 128 KiB of output instead of 256 KiB.
  ([#960](https://github.com/devswha/herdr-web-ui/pull/960))
- Ctrl+Enter in a mirrored terminal (Windows, or a PC without Node for the terminal sidecar)
  reaches Claude Code as its "send now" again instead of a plain Enter, and `bun run test:ui`
  checks it there instead of stopping at that check.
  ([#1064](https://github.com/devswha/herdr-web-ui/pull/1064))
- A password sent to a mirrored terminal is no longer submitted after the sender leaves the pane
  or switches to view-only mode; the typed characters are erased before reporting the refusal.
  ([#1065](https://github.com/devswha/herdr-web-ui/pull/1065))
- Mirrored terminals refuse passwords containing non-ASCII characters before typing anything,
  so cancellation can erase every accepted character on Windows as well. Attached terminals
  continue to accept Unicode passwords.
  ([#1065](https://github.com/devswha/herdr-web-ui/pull/1065))
- New workspace **Start** uses the folder Browse is showing, even when **Use this folder** was
  not pressed.
  ([#1169](https://github.com/devswha/herdr-web-ui/pull/1169), carrying [#1164](https://github.com/devswha/herdr-web-ui/pull/1164) by @aisensiy)
- Dragging down in a chat too short to scroll no longer reloads the app on Android Chrome before
  144; the page itself no longer starts pull-to-refresh.
  ([#953](https://github.com/devswha/herdr-web-ui/pull/953))
- Tapping an alert no longer brings forward a Markdown reader, a raw file tab or another shipped
  file the browser has open: the app window takes the pane, or the app opens on it.
  ([#958](https://github.com/devswha/herdr-web-ui/pull/958))
- An alert, a reload or a new window naming a PC removed since now opens this PC with "That
  link's PC is not set up here" instead of an empty pane. An alert for a PC set up elsewhere since
  the tab last looked waits for a fresh list of PCs instead of being dropped.
  ([#958](https://github.com/devswha/herdr-web-ui/pull/958))
- An alert for a pane that has closed (a terminal ended) opens the workspace it was in and says so
  in the header, as a link to it does, also when the phone delivers the tap twice.
  ([#958](https://github.com/devswha/herdr-web-ui/pull/958))
- An OmO question asked without waiting for its answer shows as its question card in the chat
  again, instead of a "Waiting for input" card with the terminal's text and Enter/Esc. OmO 5.1.30
  draws its running tasks under the input box, and on a narrow pane wraps the question's hint over
  two lines; either made the question unreadable. Waiting forms with tasks under the box are read too.
  ([#883](https://github.com/devswha/herdr-web-ui/pull/883))
- OmO background task counts, task lists and workflow lists now find OmO 5.x records stored
  outside the project, instead of appearing empty. Existing in-project records still work.
  ([#1138](https://github.com/devswha/herdr-web-ui/pull/1138))
- An OmO session started by a launcher that does not look like OmO (its own `OMO_CODING_AGENT_DIR`
  store, an arbitrary command name) now binds its chat only to the native session its live process
  verifiably holds in its own store. A newer file in another pane's store no longer takes its
  place, conflicting holds read as no session instead of guessing, and the chat follows the held
  session through /new and /resume.
  ([#923](https://github.com/devswha/herdr-web-ui/pull/923) by @Haeminway1)
- A terminal opened, reloaded, or reconnected in a background window watches its pane without
  acquiring an attach that could change the pane's size. Returning to the window attaches normally;
  queued messages, mirrored panes, embedded pages, and older bridges keep their existing behavior.
  ([#1130](https://github.com/devswha/herdr-web-ui/pull/1130))
- Sending a held message from two browser tabs no longer submits it twice. Its unconfirmed mark
  survives other tabs refreshing or disconnecting, and unreadable storage refuses a resend.
  After a confirmed no-input refusal, Send now starts a new attempt instead of replaying the refusal.
  ([#1088](https://github.com/devswha/herdr-web-ui/pull/1088))
- A chat message queued for the next turn is no longer delivered after the tab has gone to another
  address: a page the browser kept for Back still held its connection, so the message went out
  while the page shown said it was not confirmed. Leaving a page now ends its connection.
  ([#1005](https://github.com/devswha/herdr-web-ui/pull/1005))
- Queued chat messages are held for review when another agent process replaces their target in
  the same terminal, including agents without a native session reference.
  ([#1069](https://github.com/devswha/herdr-web-ui/pull/1069))
- A phone showing a pane's terminal no longer types into a grid another device sized: a tap into
  the input line, its Send or Enter, and a key-bar tap take the pane back to the phone's size
  before anything is sent, as a tap on the grid already did.
  ([#964](https://github.com/devswha/herdr-web-ui/pull/964))
- On a phone, opening or closing the soft keyboard no longer resizes the shared terminal: the grid
  keeps its size and the view pans so the prompt stays above the keyboard, and every other viewer
  of the pane, herdr's own window included, keeps its layout. A rotation or a pinch still refits.
  ([#1072](https://github.com/devswha/herdr-web-ui/pull/1072))
- The guide's and INSTALL.md's pairing and status commands now find the plugin with herdr 0.9.4
  and later, which moved plugin checkouts.
  ([#1136](https://github.com/devswha/herdr-web-ui/pull/1136))
- A retired push subscription is still refused after the server restarts, so Turn alerts on again
  makes a new one instead of registering the dead endpoint.
  ([#1079](https://github.com/devswha/herdr-web-ui/pull/1079))
- Turn alerts on again now makes a new push subscription when the push service retired the old
  one, instead of registering the dead endpoint again; Settings says the subscription was retired.
  ([#1060](https://github.com/devswha/herdr-web-ui/pull/1060))
- Chat messages queued for the next turn keep their original pane connection across tab and
  workspace switches and deliver once when that pane is ready. Reloads and lost connections still
  require manual recovery.
  ([#987](https://github.com/devswha/herdr-web-ui/pull/987) by @demrom)
- A phone put away while its pane stayed attached (a queued message, a mirrored pane) no longer
  comes back to a dead "Terminal output stopped" notice: when the page is in use again, the pane
  attaches again by itself, once. A stop while the page stays in use still waits for you, and the
  notice's Reconnect button now attaches again in place instead of reloading the page.
  ([#968](https://github.com/devswha/herdr-web-ui/pull/968))
- A pane on another PC no longer stops after a short network stall on a phone: the relay now stops
  output only when 256 KiB stays queued for 2 s, the same rule as this PC, instead of on any queued byte.
  ([#952](https://github.com/devswha/herdr-web-ui/pull/952))
- A terminal returning from a phone's Chat view gives its grid back only to a device still
  showing that terminal, never to a hidden pane or a tab left in the background.
  ([#1085](https://github.com/devswha/herdr-web-ui/pull/1085))
- A phone that goes back from the terminal to Chat no longer leaves a desktop showing the same pane
  at the phone's width: the terminal goes back to the desktop's size at once.
  ([#1068](https://github.com/devswha/herdr-web-ui/pull/1068))
- When the source checkout a managed server runs from is replaced under it (`herdr plugin install`
  run again, or `git pull` and a build), the app now tells you to restart herdr web ui on the PC
  instead of showing "App updated" and **Reload app**, which never went away because a reload
  loaded the same build again. The notice shows on the page's next status read, links to the
  restart commands, and goes away once the server restarts.
  ([#1146](https://github.com/devswha/herdr-web-ui/pull/1146) by @m16khb)
- A render error no longer leaves a blank page: the app shows what happened with Reload app and
  Copy details, which an installed home-screen app needs since it has no reload button. An error in
  the sidebar, a pane or Settings now stays there with its own notice, and the rest keeps working.
  ([#961](https://github.com/devswha/herdr-web-ui/pull/961))
- A long diff drawn without colors (too long to highlight, or highlighting off) no longer redraws
  every one of its lines on each scroll: it builds only the rows in view, as long files already
  do, so each scroll step of a 10 000-line diff blocks the page about half as long.
  ([#974](https://github.com/devswha/herdr-web-ui/pull/974))
- Back no longer reopens a closed Settings when another history entry (a typed `#hash`, another
  script's) was added while it was open: Back steps over the Settings entries left beneath it.
  ([#1015](https://github.com/devswha/herdr-web-ui/pull/1015))
- A reload on a file preview opened over Settings (a link naming both) now closes Settings and
  keeps the file open.
  ([#1015](https://github.com/devswha/herdr-web-ui/pull/1015))
- On a phone, a sheet opened right after another one closed (before the browser had stepped back
  off the closed sheet's history entry) no longer closes at once.
  ([#980](https://github.com/devswha/herdr-web-ui/pull/980))
- Keep the sidebar visible when herdr omits the branch field for a detached worktree.
  ([#1156](https://github.com/devswha/herdr-web-ui/pull/1156) by @christso)
- Moving a worktree or workspace down in the sidebar (drag or Alt+Down) now lands where it was
  dropped instead of doing nothing, and a repository's workspace moves together with its worktrees.
  ([#1125](https://github.com/devswha/herdr-web-ui/pull/1125))
- A click on the top right corner of a lone pane's terminal reaches the program there again, such
  as the close of Claude Code's diff panel: the pane's hidden ellipsis no longer takes it.
  ([#1160](https://github.com/devswha/herdr-web-ui/pull/1160) by @bricks-8)
- A pane dragged from the sidebar onto the pane area opens in a half even when the terminal or
  chat under the pointer redraws just before the drop; Chrome refused that drop before.
  ([#984](https://github.com/devswha/herdr-web-ui/pull/984))
- A tab left open across an update no longer stores the app's page under a script's address:
  a file the server no longer has answers 404, the offline cache is kept per build instead of
  growing with every release (typefaces and icons stay cached across updates, and an update
  keeps the files the new page starts with and the new build's math and diagram files the old
  worker had cached), and math or a diagram that failed to load, including a single diagram
  type, brings up a "Reload app" line at once, in a Markdown file opened in its own tab too.
  ([#957](https://github.com/devswha/herdr-web-ui/pull/957))
- A message sent right after Stop in the chat composer no longer reaches the agent before the
  Stop on a busy PC, and typing in the terminal keeps its order.
  ([#1112](https://github.com/devswha/herdr-web-ui/pull/1112))
- The chat command picker now includes symlinked skills and custom commands, skipping broken links and command directory cycles.
  ([#981](https://github.com/devswha/herdr-web-ui/pull/981) by @demrom)
- The diagram viewer's toolbar keeps clear of a notch or rounded corner on a phone held sideways.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- A long Markdown file opens its Preview in parts, so the page no longer stalls for about a second on a slow machine while it draws.
  ([#951](https://github.com/devswha/herdr-web-ui/pull/951))
- Tailscale login headers forwarded by another local proxy no longer grant owner access unless
  the forwarded address is a single tailnet address. Header-free, serve-only owner access is preserved.
  ([#1062](https://github.com/devswha/herdr-web-ui/pull/1062))
- The terminal input line turns off the phone keyboard's autocorrect and spell-check, as the
  composer does, so a flag, path or branch name is no longer swapped for a dictionary word before
  Send.
  ([#965](https://github.com/devswha/herdr-web-ui/pull/965))
- Holding ⌫, Del, Home, End, PgUp or PgDn in the touch key bar repeats it until release, as a held
  arrow already did, instead of sending one key. Esc, Tab, Enter and ^C still send once.
  ([#965](https://github.com/devswha/herdr-web-ui/pull/965))
- The terminal input line's Send no longer does nothing when tapped while the keyboard is still
  composing the last word (Gboard, Korean, Japanese and Chinese keyboards): the tap finishes the word
  and sends the line, and says "Finish the word, then send." when the keyboard still does not commit it.
  ([#959](https://github.com/devswha/herdr-web-ui/pull/959))
- On Android, dragging a text selection on a pane no longer opens the pane's menu when the finger
  lifts; Copy and the phone's own selection menu stay in front.
  ([#1159](https://github.com/devswha/herdr-web-ui/pull/1159))
- Dragging the terminal on a phone now scrolls by how far the finger travels: a quick swipe goes as
  far as a slow drag over the same distance, one scroll step per three rows of travel, and a short
  flick of at least half a step still scrolls once when the finger lifts.
  ([#963](https://github.com/devswha/herdr-web-ui/pull/963))
- Chat turn times follow the day change: a turn shown as today's time reads "yesterday at …" after
  local midnight without reopening the chat, from one shared timer that re-renders only the times.
  ([#973](https://github.com/devswha/herdr-web-ui/pull/973))
- A terminal pane left open and quiet no longer asks herdr for its scroll position every second:
  the scrollbar's poll backs off to every 15 seconds and speeds up again on output, scrolling,
  resizing or returning to the tab. A view scrolled up into history keeps its 1 second read, since
  herdr holds that view still while new output grows the history below it, and a failed read
  still retries after 1 second. Each drawn frame also no longer measures the page layout unless a search has highlights to place, which saves battery on phones.
  ([#955](https://github.com/devswha/herdr-web-ui/pull/955))
- On Windows, a failed write to a helper process that already closed its input no longer ends the
  server.
  ([#971](https://github.com/devswha/herdr-web-ui/pull/971) by @Noobear)
- On Windows, OmO is offered when creating a workspace or a tab, as gjc already was.
  ([#885](https://github.com/devswha/herdr-web-ui/pull/885) by @willowite)
- Stopping the Windows plugin waits until its original process tree has exited.
  ([#1074](https://github.com/devswha/herdr-web-ui/pull/1074))
- Windows remote PCs now connect to the herdr socket under `XDG_CONFIG_HOME` when set.
  ([#1070](https://github.com/devswha/herdr-web-ui/pull/1070))
- A workspace or tab name can no longer be saved blank or longer than 80 characters: the server
  refuses it, the name fields stop at 80, and clearing a name in the sidebar or the tab strip says
  a name is needed instead of saving nothing or ignoring the Enter.
  ([#1011](https://github.com/devswha/herdr-web-ui/pull/1011))
- A workspace made on a repository's folder offers New worktree and Open worktree… in its row menu
  again. Since 0.4.6 the two showed only once the repository already had a worktree open.
  ([#993](https://github.com/devswha/herdr-web-ui/pull/993))
- New worktree in a repository that has no commit yet says so, instead of showing git's
  `fatal: invalid reference: HEAD`.
  ([#993](https://github.com/devswha/herdr-web-ui/pull/993))
- A connection attempt that hangs (a phone waking on a dead network) is given up after 8 seconds
  and tried again with a longer wait each time (up to 30 seconds), so a slow but working link
  such as a remote PC still connects, instead of leaving the app disconnected until reload.
  ([#954](https://github.com/devswha/herdr-web-ui/pull/954))
- A page coming back to the screen, or a network coming back, with a dead connection reconnects
  at once, even when the browser had not yet reported the connection closed or a retry was
  still waiting out a long deadline.
  ([#954](https://github.com/devswha/herdr-web-ui/pull/954))
- A connection that went dead without closing (a phone moving from Wi-Fi to cellular, or waking
  after its network changed) no longer leaves the terminal frozen while it still shows connected.
  The app checks the connection when the page comes back, the network changes or nothing arrived
  for 20 seconds, and reconnects when two checks a few seconds apart get no answer; a slow link
  gets longer each time it is dropped. Keys typed during the check are kept as held input instead
  of being lost, and a message sent during the check waits for the answer instead of failing. The
  key bar comes back as soon as the answer does, and a PC on an older version is no longer dropped
  after a reconnect.
  ([#967](https://github.com/devswha/herdr-web-ui/pull/967), [#972](https://github.com/devswha/herdr-web-ui/pull/972))
- Once terminal input is held, later typing joins the held input until you send or discard it,
  also after the terminal is ready again: a command is never split between the held text and the
  terminal, and Enter never runs the part that already reached it. Ctrl+Enter, a paste the held
  input cannot take (a tab, for one), the input line's Send and the message box's Send (a queued
  "Send now" too) are refused with a note saying to send or discard the held input first.
  ([#967](https://github.com/devswha/herdr-web-ui/pull/967), [#972](https://github.com/devswha/herdr-web-ui/pull/972))

#### Maintenance
- The remote-PC runtime is now version 28: every saved PC asks for **Update bridge…** once.
- The pending-input "turn never starts" test waits for the recorder to log the bridge's Enter
  before comparing the bytes, instead of racing it.
  ([#979](https://github.com/devswha/herdr-web-ui/pull/979))
- Four browser checks no longer fail on a slow run: the terminal input check waits for the
  connection before it asks for a liveness probe, the update line and plan-limit checks count a
  request once it has been answered or by the page that made it, and the phone transcript check
  reads the transcript's style in one step.
  ([#1001](https://github.com/devswha/herdr-web-ui/pull/1001))
- CI's browser lanes run a failed script a second time. One that then passes is reported as flaky
  (a warning on the run, its first log kept) instead of failing the job; one that fails twice
  still fails it.
  ([#1002](https://github.com/devswha/herdr-web-ui/pull/1002))
- The SSH password test pulls its disposable PC's image from a second and a third registry when
  one refuses the runner for its pull limit, instead of failing on a limit that is not the
  test's.
  ([#1016](https://github.com/devswha/herdr-web-ui/pull/1016))
- The prompt dock check waits for the answered question's own card to go, not for any card: the
  demo's approval could take its place at once and the wait then ran out.
  ([#1016](https://github.com/devswha/herdr-web-ui/pull/1016))
- Browser CI reports name the failing assertion and script line, and a read-only CLI ranks
  failures and flakes from recent workflow attempts.
  ([#1009](https://github.com/devswha/herdr-web-ui/pull/1009))
- The self-hosted CI runners of one PC share `bun run check`'s slots: their Integration and
  Browser regression jobs wait for a slot instead of all running at once and failing each other's
  timing-bound tests.
  ([#1086](https://github.com/devswha/herdr-web-ui/pull/1086))
- `bun run dev` no longer answers every state-changing request with 403 `invalid_origin`: Vite's
  `/api` proxy keeps the browser's Host, which the server's same-origin check compares with Origin.
  ([#1003](https://github.com/devswha/herdr-web-ui/pull/1003))
- The user guide covers the image viewer, skill chips, the project favicon, the composer's folder
  strip, Files → Changes, the large-file source view, the
  palette's Settings pages and folder browsing, and the new Appearance settings; the agent guides
  point to their code and to `GET /api/workspace/diff/files` and `/diff/file`.
  ([#975](https://github.com/devswha/herdr-web-ui/pull/975))
- herdr RPCs are typed per method (`HerdrMethods`): server code calls `paneProcessInfo`,
  `agentGet` and the other wrappers in `server/herdr/client.ts`, and `server/conventions.test.ts`
  keeps it off the untyped `herdrRpc`, so asking `pane.process_info` by `target` no longer compiles
  without an explicit result type.
  ([#970](https://github.com/devswha/herdr-web-ui/pull/970))
- The browser scripts and `scripts/check.test.ts` run on a Mac as they are: a script without
  `CHROME_PATH` falls back to the lockfile's Playwright Chromium where Google Chrome's Linux path
  does not exist, the check tests make their scratch directories under `/tmp` so a socket inside
  stays within the path limit, and `scripts/output-browser-qa.ts` opens its page in English
  whatever the PC's language.
  ([#1004](https://github.com/devswha/herdr-web-ui/pull/1004))
- The math browser check answers a conversation request that reaches its server while the browser
  closes, instead of failing after every check has passed.
  ([#1027](https://github.com/devswha/herdr-web-ui/pull/1027))
- The pane paging browser check waits for the demo's opening turn to end before it measures scroll
  positions: that turn ends 4.5 s after load and changes the transcript's height, which broke the
  check on a loaded runner.
  ([#978](https://github.com/devswha/herdr-web-ui/pull/978))
- `scripts/repo-diff-browser-qa.ts` waits for the diff's worker colors before it selects and
  copies rows: the colored redraw dropped a selection made on the plain rows, so the copy came
  back empty.
  ([#980](https://github.com/devswha/herdr-web-ui/pull/980))
- The terminal input check waits for the snapshot before it asks for a liveness probe: on CI the
  snapshot can follow the pane's first frames by a few milliseconds, and a wake before it probes
  nothing.
  ([#1019](https://github.com/devswha/herdr-web-ui/pull/1019))
- The browser run's phone and desktop plan checks no longer lose the plan chip to the roster the
  server pushes over its event stream, and its split-view drag waits for each step the page shows
  before the drop.
  ([#983](https://github.com/devswha/herdr-web-ui/pull/983))
- On Windows, the browser and SSH scripts find the test herdr session: they look under
  `XDG_CONFIG_HOME` first, then `%APPDATA%`, as herdr does.
  ([#884](https://github.com/devswha/herdr-web-ui/pull/884) by @willowite,
  [#1032](https://github.com/devswha/herdr-web-ui/pull/1032))
