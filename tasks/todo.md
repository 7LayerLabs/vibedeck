# Where things stand (updated 2026-10-16, end of session)

## Done this session (all pushed to GitHub, main)
1. **Clone from Git** (commit dc95fc1). Paste a repo link, pick a folder, clone with progress, open it.
2. **Smoothness pass** (next commit, details in its section below):
   - Root cause 1: answer and prompt highlights leaked a line marker every time they were
     redrawn (twice per finished answer, every resize). Leaked markers made output parsing
     ~145x slower once scrollback filled (1,166 ms vs 8 ms for 3,000 lines). Fixed.
   - Root cause 2: one decoration per highlighted line, all revisited every frame. Now only lines
     near the view get real decorations (at most ~220 instead of up to 6,000 per pane).
   - Gliding mouse-wheel scroll.
   - Copy: Ctrl+C copies a selection, copy on select, right-click copy/paste, Copy reply button.
   - Desktop app bug: every clipboard write was denied ("Write permission denied"), so all
     existing Copy buttons silently failed in the desktop app. Clipboard is now allowed.

## What's left
- [ ] **Derek tries it in the real app**: scrolling in a long session, the four copy behaviors,
      and the Clone from Git **Browse** button (native folder picker, untested by me).
- [ ] **Other PC**: `git pull` in its vibedeck folder (no new packages this time).
- [ ] Prompt highlights: marker leak fixed and styled once, but not windowed like answer
      highlights. Only worth doing if long sessions still feel jerky.
- [ ] Quitting VibeDeck in the middle of a clone: the half-made folder may be left (untested).
- [ ] `npm audit` reports 10 known issues in dependencies (1 critical, 1 high). Not looked at yet;
      check which packages before running any fix (`--force` can break things).
- [ ] INSTALL.md says `git clone https://github.com/7LayerLabs/pointer-.git`, but this repo is
      7LayerLabs/vibedeck. Confirm which is right and fix the doc.
- [ ] With gliding scroll, Ctrl+Shift+Up/Down pressed very fast (within ~120 ms) may land on the
      same prompt twice. Untested, minor.
- [ ] `tasks/todo.txt` is an older untracked copy of the compare-loop sprint notes; left alone.

## How to test without touching real data
- Browser mode: `VIBEDECK_DATA_DIR=<scratch folder> VIBEDECK_NO_PANES=1 VIBEDECK_PORT=<n> node server.js`
  prints a private link. Put a `state.json` with `"kinds":["shell"]` and a `cwd` in that folder
  to get one free shell pane.
- Desktop app: `node_modules/electron/dist/electron.exe . --user-data-dir=<scratch folder>
  --remote-debugging-port=9333` runs a separate copy (own data, own single-instance lock) that a
  CDP script can drive. Call `Page.bringToFront` first or a background window's timers crawl.
- Timing loops: set `term.options.smoothScrollDuration = 0` first. With glide on,
  `scrollLines()` moves the view on later frames, so a synchronous loop never ends.

---

# Project: VibeDeck — Smoothness pass (BUILT 2026-10-16)

## What Derek said
"Doesn't have that smooth fluidity to it yet. NO auto copy replies, feels jerky when scrolling etc."

## What I measured (throwaway instance, one pane, 6,000-line session with answer highlights)
Cost of one scroll step (3 lines) in one pane, timed directly (Chrome throttled the test tab,
so frame rates were not usable):
| | highlight refresh | text redraw | total |
|---|---|---|---|
| highlights on, after scrolling through the session | 4.5 ms | 6.1 ms (spikes 31) | 10.6 ms |
| highlights off | 0 | 0.4 ms | 0.4 ms |
| only the newest 380 lines scrolled | 0.3 ms | 1.5 ms | 1.9 ms |
The 60fps budget is 16.7 ms per frame, before the browser paints.
- Root cause: each highlighted line is its own xterm decoration. Once a line has been on screen,
  xterm keeps a page element for it and revisits every one of them on every frame
  (`_doRefreshDecorations`), and answer-marks re-applies their style each time. So the longer
  the session and the more you scroll around, the jerkier it gets.
- Copy: Ctrl+C with text selected sends "stop" to the AI instead of copying. No right-click
  menu in panes. No copy button for a pane's reply (only in Compare).

## Plan (Derek picked all four copy behaviors)
### Scroll (root cause)
- [x] `answer-marks.js`: scan() records stretches (one marker per stretch); sync() keeps real
      decorations only within 2 screens of the view, run from `term.onRender`. A summary's
      first line (scrollbar mark) stays pinned.
- [x] Style each highlight element once, not every frame (both files)
- [x] **Found during the build:** xterm's decoration `dispose()` does not dispose its marker, and
      neither file disposed them. Every rescan leaked a marker per highlighted line. Both files
      now dispose the marker with the decoration.
- [ ] `prompt-marks.js` windowing: not done (see "What's left")
- [x] Glide wheel scrolling: `smoothScrollDuration: 120`
- [x] Re-measured (numbers below)

### Copy
- [x] Ctrl+C copies a selection (else still "stop"); Ctrl+Shift+C only copies
- [x] Copy on select
- [x] Copy reply button in each AI pane's header (from `paneFinal` / `paneFinals`)
- [x] Right-click: copy the selection, or paste
- [x] `desktop/main.cjs`: allow `clipboard-sanitized-write` and `clipboard-read` (everything else
      still denied). Before this, every clipboard write in the desktop app failed.

### Finish
- [x] `npm test` green (40/40)
- [ ] Derek tries it in the real app

## Review
| File | Change |
|------|--------|
| `public/answer-marks.js` | spans + `sync()` window (NEAR = 2 screens), pinned summary-start line, `drop()` disposes marker with decoration, style-once `onRender`, rescan trigger checks spans |
| `public/prompt-marks.js` | `drop()` disposes markers too; style-once `onRender` |
| `public/app.js` | `smoothScrollDuration: 120`; Ctrl+C / Ctrl+Shift+C; copy on select (mouseup after a left-button press in the terminal); right-click copy/paste; `.copyreply` button + `setLastReply`; `copyText` helper with a failure toast |
| `desktop/main.cjs` | permission handlers allow clipboard read/write only |
| `README.md` | copy + glide line under Workbench |

Measured (one pane, 6,000-line session, 30 answers):
- Desktop app, 3,000 lines of output once scrollback is full: **old 1,166 ms** (36,000 leaked
  markers after 5 rescans) vs **new 8 ms** (markers flat at 90-202).
- Live decorations: old up to 6,000 per pane; new at most 220.
- Scroll step cost in Chrome browser mode, old code: 10.6 ms with highlights vs 0.4 ms without.
  In the desktop app the timing harness carries ~8 ms of fixed overhead per step (no-highlight
  baseline 9.2 ms), so old (7.9) vs new (7.2) there is inside the noise. Judge scroll by feel.
- Copy behaviors driven with real mouse/key events in an isolated desktop app: all pass.
- Screenshots: summary card and faded work lines look the same as before, including lines
  that scroll into view.

---

# Project: VibeDeck — Feature: Clone from Git (BUILT + PUSHED 2026-10-16, dc95fc1; desktop Browse untested)

## What Derek asked
"Open a folder from a git repo, then set up a folder on the PC to move that git to."
Read as: paste a repo link, pick (or make) a folder on this PC, VibeDeck clones the
repo there and opens it as the project. (Not a single subfolder of a repo.)

## What it looks like
A **Clone from Git** section in two places: the Project folder popover, and the
"Choose a project folder" start screen.
1. **Repo link**: `https://github.com/owner/repo(.git)`, `github.com/owner/repo`,
   or `git@github.com:owner/repo.git`
2. **Put it in**: a parent folder. Browse opens the Windows folder picker, which has a
   New folder button, so a new home like `C:\Users\Derek\code` can be made on the spot.
   Remembered for next time. First time: the folder the current project sits in.
3. **Folder name**: filled in from the repo name, editable.
4. **Clone**: a progress line ("Receiving objects 42%") with Cancel. When done,
   VibeDeck opens the new folder (every pane restarts there, same as Open here) and it
   joins Recent folders.

## Rules
- Never overwrites: refuses if the target folder exists and is not empty.
- Only https and ssh links (no `file://`, no `ext::`). git runs directly with no
  shell, and the link goes after `--`, so an odd link can't run commands.
- Private repos use the Git sign-in already on this PC (Git Credential Manager,
  7LayerLabs). If git needs a sign-in it can't get, show git's error; never hang.
- Cancel stops git and removes only the half-made folder this clone created.
- Blocked while a pipeline runs (same rule as switching folders).

## Plan
- [x] `lib/git-clone.js` (new): link check, folder name from link, run
      `git clone --progress`, parse progress, cancel + cleanup
- [x] `server.js`: `cloneRepo` / `cloneCancel` messages, progress to the screen,
      open folder on success, remember parent in state.json; pickFolder takes a title
- [x] `desktop/main.cjs`: folder picker title comes from the request
- [x] `public/index.html`, `public/app.js`, `public/styles.css`: the Clone section
      (popover + start screen), progress line, Cancel
- [x] `test/git-clone.test.js`: link check, folder names, existing-folder refusal
- [x] README: one line under features
- [x] Verify on a TEST instance (own data dir, browser mode): clone a public repo
      into the scratchpad, confirm it opens + shows in recents; confirm the
      non-empty-folder refusal and Cancel cleanup. Live state.json untouched.
- [ ] Verify the Browse picker in the desktop app (needs Derek: restart VibeDeck,
      Project folder menu > Clone from Git > Browse)
- [x] `npm test` green (40/40: 36 existing + 4 new)
- [x] Review section below

## Out of scope
Branch picker, shallow clones, submodules, cloning into the current project.

## Review
| File | Change |
|------|--------|
| `lib/git-clone.js` | **new**: `normalizeUrl` (https/ssh only; GitHub browser links trimmed to the repo), `repoName`, `checkName` (one safe folder name), `destination` (parent must exist, target missing or empty), `clone` (spawn git, no shell, link after `--`, `GIT_TERMINAL_PROMPT=0`, progress, cancel = `taskkill /T /F` on Windows, cleanup of only what it made) |
| `server.js` | `cloneRepo` / `cloneCancel`; one clone at a time; blocked during pipelines; on success runs the normal `setcwd` path (panes restart, recents updated); `state.cloneParent` remembered; `cloneParent` in init; clone killed on shutdown; `pickFolder` takes title + default path |
| `desktop/main.cjs` | folder dialog title from the request; `createDirectory` (macOS New Folder; Windows has it natively) |
| `public/index.html`, `app.js`, `styles.css` | one `<template>` form placed on the start screen and in the Project folder popover; folder name placeholder follows the link; progress/error line + Cancel shared by both copies |
| `test/git-clone.test.js` | **new**: link rules, names, destination refusals, real local clone: success, failure cleanup, failure into an empty folder keeps the folder, cancel cleanup |
| `README.md` | Clone from Git paragraph under First run |

Verified on a throwaway server (own data dir, no panes):
- bad link refused
- `github.com/.../tree/main` link cloned + opened
- second clone into the same folder refused, files intact
- VS Code clone cancelled 20 MB in: half-made folder (28 entries) fully removed, no git processes left behind
- UI: start-screen form, red refusal line, Enter clones and opens, popover form clears and remembers the destination, no console errors

Notes / follow-ups:
- Progress updates are throttled to one per 150ms, so the last % before "done" can be skipped. Harmless.
- Quitting VibeDeck mid-clone stops git, but the engine exits ~300ms later, so cleanup of the half-made folder may not finish (untested). If one is left, the next clone into it is refused with a clear message; delete it by hand.

---

# Project: VibeDeck — Sprint: trustworthy compare loop

## Problem Statement
VibeDeck's broadcast → compare → promote loop is the product core, but answers
are scraped from raw PTY bytes (`cleanTui`), winners only bump a local tally,
history stores prompts only (not answers), judge always hardcodes Claude, and
missing CLIs fail silently. This sprint makes the loop **accurate, decisive,
and recoverable** without bloating the monofile architecture.

## Scope (this sprint only)
1. Better answer extraction (display paths only — settle logic untouched)
2. Promote winner → next context
3. CLI health on boot
4. Round history (prompt + answers + winner)
5. Blinded judge + judge picker (Claude / Codex)

**Out of scope:** React rewrite, Electron, roster plugins, cloud sync, yolo
policy UI, hybrid headless pipeline steps, Grok as judge (no reliable
headless mode — deliberately dropped, not deferred).

## Plan revisions vs. the original draft (agreed before build)
- **A2 changed:** `extractAnswer` is display-only (compare, relay, notes,
  judge, rounds storage). `settledAnswer` and the round watcher stay on
  `cleanTui` — its length-stability IS the done signal, and a "last block"
  extractor's length jumps around during repaints.
- **Extraction approach changed:** instead of "last contiguous block" (which
  drops the scrolled-off head of long answers — scrollback lines print once,
  early), extractAnswer = cleanTui + partial-paint prefix removal (a line
  whose normalized form (≥6 chars) is a strict prefix of a later line is a
  truncated repaint; drop it).
- **E0 added:** the judge is now BLIND — answers go in unlabeled so a judge
  can't favor its own entry; the label legend is prepended to the verdict
  server-side after it returns.
- **Order changed:** Track C (health) went first — zero risk, instant win.
- **Fixture harvesting:** `VIBEDECK_CAPTURE=1` dumps each settled pane's raw
  bytes to `data/raw-rounds/` so real transcripts can grow the fixture set.

---

## Plan (all complete)

### Track C — CLI health on boot
- [x] Boot-time check: `fs.existsSync` on Windows (ROSTER paths are absolute),
      `which` on mac/linux; claude/codex/grok only
- [x] `health` array in ws `init`
- [x] Client: dismissible strip under the header with install hints

### Track A — Answer extraction
- [x] `lib/screen.js`: stripAnsi / segmentAnsi / cleanTui moved verbatim;
      new `extractAnswer` (display-only, see revisions above)
- [x] Wired into `roundResponses`, relay, `pushToNotes`, rounds storage —
      NOT into `settledAnswer` (deliberate)
- [x] `test/fixtures.js` + `test/extract-fixtures.js`, `npm test` (42
      assertions, 4 fixtures: claude repaint, codex stream, short answer,
      prefix-vs-short-line)
- [x] Raw capture rig behind `VIBEDECK_CAPTURE=1`

### Track D — Round history
- [x] `data/rounds.jsonl` written when a round settles: ts, prompt, cwd,
      responses (text capped 16KB each), winnerKind; capped at last 200
- [x] Prompt `history.jsonl` unchanged (↑/↓ cycling identical)
- [x] History overlay: Prompts | Rounds tabs; rounds searchable, chips per
      model, winner chip; row click loads prompt; compare button reopens the
      full round snapshot in the compare overlay
- [x] Crown patches the round's winnerKind (pendingCrown covers crowning
      before the round file write lands)

### Track B — Promote winner
- [x] `promote` button per compare column → fills the prompt bar with
      original prompt + winner answer + "Next:", cursor at end
- [x] Promoted mega-prompts broadcast with `noHist:true` — they'd pollute
      ↑/↓ cycling and rounds.jsonl already records them
- [x] Winner button keeps the localStorage tally AND sends `crown`

### Track E — Judge
- [x] E0: blind judging (unlabeled answers; legend prepended to verdict)
- [x] `judge` message takes `kind`; server validates against JUDGE_KINDS
- [x] Runners: claude `claude -p`, codex `codex exec -` (both stdin);
      verdict/err stripped of ANSI; judge kind shown in the verdict header
- [x] Picker in compare header, persisted in localStorage
- [x] Grok: intentionally not offered (see out-of-scope)

### Finish
- [x] npm test green
- [x] Server restarted + smoked
- [x] Review below

---

## Review

### Changes Made
| File | Change |
|------|--------|
| `lib/screen.js` | **new** — extraction helpers; `cleanTui` doubles as the settle signal (warning comment in file), `extractAnswer` is display-only |
| `server.js` | health check + JUDGE_KINDS at boot; rounds.jsonl read/append/crown; blind judge with kind; extractAnswer on all display paths; noHist; capture rig; init gains health/judges/rounds |
| `public/index.html` | health strip, judge picker, promote + crown in compare, Prompts/Rounds history tabs, help row |
| `test/fixtures.js`, `test/extract-fixtures.js` | **new** — 4 ANSI fixtures, 42 assertions, no framework |
| `package.json` | `npm test` script |

### Key decisions
- Settle detection (`settledAnswer`, quiet-done fallback) is untouched — the
  riskiest part of the original plan was wiring new extraction into it, and
  that was deliberately not done.
- Judge bias fix (blinding) shipped alongside the picker; the picker alone
  wouldn't have fixed Claude grading its own homework.
- Tests caught one real bug pre-ship: codex's `tokens used:` footer wasn't in
  `CHROME_LINE`. Fixed; also improves settle stability (the counter changes
  every repaint).

### Notes / follow-ups
- Pipeline steps do NOT write rounds.jsonl (they set lastRound without
  `pending`) — intentional for v1.
- To grow fixtures from real transcripts: run with `VIBEDECK_CAPTURE=1`,
  broadcast normally, harvest `data/raw-rounds/*.txt`.
- If codex-as-judge misbehaves, check `codex exec -` reads stdin on the
  installed version; failure is reported honestly in the verdict box.
