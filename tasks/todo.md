# Project: VibeDeck — skip-permissions everywhere + ⟳ update models

## Problem Statement
Claude panes bypass permissions only via Derek's global settings; codex/grok
still stop to ask. And model lists are hard-coded in index.html KNOBS, so new
releases require a code edit.

## Plan
- [x] Task 1: per-CLI skip-permissions flags in ROSTER (claude
      --dangerously-skip-permissions, codex
      --dangerously-bypass-approvals-and-sandbox, grok --always-approve),
      applied at every spawn; auto-accept claude's bypass warning dialog
      (send "2" — plain Enter would pick "No, exit")
- [x] Task 2: models.json = source of truth for model/effort lists; served in
      init; client KNOBS reads choices from it
- [x] Task 3: ⟳ update models button — grok via `grok models` (authoritative),
      claude/codex by opening /model in their live pane, scraping the painted
      menu, Esc to close; sane-parse guard keeps old list on unclear scrape;
      results saved to models.json + broadcast, dropdowns repopulate live
- [x] Task 4: restart + verify all panes boot yolo, run update-models e2e
- [x] Task 5 (added mid-flight): image paste/drag — drop or Ctrl+V an image on
      a pane; server saves to data/images/ and types the path into the CLI

## Review
### Changes Made
- Verified via e2e ws client: claude/codex boot fine with yolo flags; ⟳ report
  "grok 2 (live) · claude 4 (scraped) · codex pane busy — kept old" (busy pane
  = honest soft-fail, click ⟳ again); image saved + path typed into claude.
- Scrape bug found: stripAnsi without cursor-move segmentation fuses menu text
  ("opusopus4", "gpt-5.4Strong"). Extracted segmentAnsi() (CUF→space, CUP→\n)
  now shared by cleanTui and the scraper; codex regex is case-sensitive so a
  fused capitalized description ends the match; claude alias = first word of
  each numbered menu entry, lowercased. Scrapes needing trust: ≥2 models.
- models.json is runtime-updated → gitignored; code defaults cover fresh clones.

- Follow-ups from Derek watching the UI: per-pane "yolo" toggle button next to
  the knobs (amber when on, default on, restart applies it; hidden for shell);
  no-cache static serving (stale UI was why ⟳ looked missing); scrape retries
  3x when a pane is busy — codex now discovers gpt-5.6-sol/terra/luna.
- Image drop/paste verified e2e: file saved to data/images/, path typed into
  the pane's CLI input.

### Notes
- Esc cancels claude's /model picker without changing the model — the ⟳ scrape
  is safe mid-session, panes just show the menu flash open/closed.
- claude's bypass-warning dialog (first run only) defaults to "No, exit"; the
  auto-accept types "2", never plain Enter.

---

# Project: VibeDeck — Auto-Pipelines

## Problem Statement
Relay is manual: you watch a pane finish, then pick "→ relay". Auto-pipelines
run a whole chain hands-free: type one prompt, pick a pipeline, and the server
sequences it — e.g. Claude plans → Codex builds → Grok reviews.

## Design
- Pipeline = JSON file in `pipelines/` (like playbooks): named steps, each with
  a `kind` (claude/codex/grok/shell) and a `prompt` template. `{prompt}` = the
  user's typed prompt, `{output}` = previous step's cleaned answer.
- Each step targets the first alive pane of that kind (error toast if missing).
- Completion detection: a step is done when its pane's cleaned round output
  (cleanTui) has stopped growing for 8s AND the pane's ready pattern is visible
  again. Spinners are already filtered by cleanTui, so Grok's constant
  animation doesn't fake progress. Per-step timeout 10 min. One pipeline at a
  time; cancel button aborts.
- UI: "pipeline ▾" dropdown next to playbooks. Type a prompt, pick a pipeline,
  it runs. Status chip in the prompt bar (step 2/3 · CODEX · cancel ×).

## Plan
- [x] Task 1: `pipelines/` dir + two defaults (plan→build→review,
      answer→critique→revise); served in ws `init` (mirrors readPlaybooks)
- [x] Task 2: server pipeline runner — startPipeline/advancePipeline/endPipeline
      + 1s done-detection tick (cleaned output stable 8s, no "esc to interrupt"
      in tail, ready pattern back); 10-min step timeout; cancel drops later steps
- [x] Task 3: UI — pipeline dropdown (⛓ name + step labels), amber status chip
      with cancel ×, toasts on done/error/cancel; late-joining clients get the
      current step on connect
- [x] Task 4: end-to-end test with a small real prompt across 3 panes

## Progress Notes
- Each pipeline step sets lastRound, so Compare live-shows the running step
- Pipeline prompts are saved to history like broadcasts

## Review
### Changes Made
- `pipelines/` dir + 2 defaults: plan→build→review (claude→codex→grok),
  answer→critique→revise (claude→grok→claude); plain JSON, `{prompt}` = typed
  prompt, `{output}` = previous step's cleaned answer; steps target the first
  alive pane of their kind
- `server.js`: readPipelines, startPipeline/advancePipeline/endPipeline, 1s
  done-detection tick, ws handlers (pipeline/pipelineCancel/pipelines), current
  step re-sent to late-joining clients
- `public/index.html`: ⛓ pipeline dropdown, amber status chip + cancel ×, toasts
- Bug found in test 1: ROSTER `ready` patterns are startup-only signals (claude's
  post-answer screen is just "❯") — using them as a done condition hangs the step.
  Done = cleaned output stable 8s + (raw-quiet 4s OR no "esc to interrupt" tail).
- Bug found in test 2: multi-line prompts paste-ingest slowly; Enter at 150ms
  never submits (stuck "[Pasted text #N]"). writePrompt now scales the Enter
  delay with line count (600ms + 25ms/line, cap 3s).
- cleanTui hardened: paste-widget + "Turn completed in Ns" chrome filtered;
  lines contained in the prompt (input-box echo fragments) dropped.
- E2E verified: answer→critique→revise ran 3 steps in 83s, real content flowed
  through both handoffs, final revision captured.

### Notes
- Cleaned output still carries some partial-repaint garble (Ink cursor-forward
  paints). Proper fix someday: feed each pane through @xterm/headless and read
  the real screen instead of regex-scraping the raw stream — would upgrade
  compare/relay/judge/pipelines all at once.
- Steps time out after 10 min; cancel drops later steps but leaves the current
  pane running. One pipeline at a time.

---

# Project: VibeDeck — multi-AI terminal cockpit (formerly TriTerm)

## Problem Statement
Ghostty-style local app for vibe coders: one prompt bar broadcasts to 1-4 live
terminal panes running AI CLIs (claude/codex/grok/shell, duplicates allowed).
Each pane stays fully interactive for answering questions/permissions.

## Plan
- [x] Scaffold Node project (express/ws/@lydell/node-pty/xterm, prebuilt PTY)
- [x] PTY server with websocket bridge, scrollback replay, restart, resize
- [x] Prompt bar + xterm panes, per-pane broadcast toggle, Ctrl+1..4 / Ctrl+0
- [x] WebGL renderer + resize-nudge (DOM renderer smeared TUI redraws)
- [x] Dynamic panes: 1-4 count dropdown, 2x2 grid at 4, persisted to panes.json
- [x] Per-pane CLI dropdown (replace), ◀ ▶ placement, instance-based (3 Claudes OK)
- [x] Model/effort knobs, verified live: claude /model + /effort (staged typing);
      codex/grok relaunch with -m (they can't switch mid-session)
- [x] Rename TriTerm → VibeDeck (folder, bat, UI, memory)

## Review
### Changes Made
- `C:\Users\Derek\vibedeck` — server.js (instance sessions, add/close/reorder/
  replace/restart-with-args), public/index.html (all UI), VibeDeck.bat
- Verified model lists: claude fable/opus/sonnet/haiku + effort low..max;
  codex gpt-5.5/gpt-5.4/gpt-5.4-mini/gpt-5.3-codex-spark; grok grok-4.5/grok-composer-2.5-fast

### Notes
- Claude slash commands must be typed staged (cmd, arg, Enter separately)
- Claude trust dialog eats the first input of every fresh session — click it once
- Esc deliberately not bound; CLIs use it to interrupt
