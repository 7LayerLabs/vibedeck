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
