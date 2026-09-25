# VibeDeck desktop release

## Release candidate scope

Version 2.1.0 adds the approved light workbench, supplied VibeDeck logo, configurable named pipelines, explicit handoff review, protected local connections, and Electron installer packaging.

## Verified on Windows

- Existing extraction suite: 42 assertions across four fixtures.
- Pipeline validation, stage handoff, cancellation and failure tests.
- Real child-process adapter test, including paths with spaces and literal prompt punctuation.
- HTTP session protection and WebSocket origin rejection; saved pipeline persistence.
- Windows x64 NSIS installer build.
- Packaged Electron Node runtime, native PTY launch, shell command round trip, and writable user profile smoke test.
- Browser rendering of the production pipeline builder.

## Required before public stable release

- Windows signing identity and signed installer validation.
- macOS builds, signing with Developer ID, notarization, and clean-device launch validation on Apple silicon and Intel.
- Broader authenticated workflow validation across supported CLI versions, model choices and account plans. The default-model Claude/Codex/Grok handoff passed locally; that does not establish access for every account or model.
- Clean-device installer/update/uninstall checks and long-running terminal/pipeline recovery checks.
- Review and merge the application and product-page pull requests; verify the deployed /vibedeck route.
- Publish verified installers and checksums, then enable direct download URLs on the product page. Do not advertise unbuilt, unsigned or untested artifacts as a stable release.

## Build artifacts

Local Windows candidate: `dist/VibeDeck-2.1.0-win-x64.exe` (unsigned).
GitHub Actions uploads platform artifacts for review and does not publish releases automatically.

The desktop wrapper does not install or authenticate third-party CLIs automatically. Provider accounts, permissions and model availability remain under the user's control.

## Expanded provider connections

Added Grok CLI pipelines, Anthropic/OpenAI-compatible API adapters, local Ollama/LM Studio presets, custom endpoints and optional OS-encrypted API-key persistence. Subscription sign-in stays inside provider-supported CLIs. API stages return text/proposed code; they do not edit files. New tests cover protocol payloads, keys excluded from metadata, endpoint changes, cancellation and incomplete/error responses. No live provider credentials were used in these tests.

## Live verification — 2026-09-23

- Claude, Codex and Grok returned actual answers through the production CLI adapter using existing sign-ins.
- `node test/live-pipeline.cjs` passed: Codex planned, Claude created a marker file, Grok read/reviewed it, and the test independently checked its exact contents. This optional manual check consumes account usage and works only inside its own temporary directory.
- The UI now opens each installed provider's login command, tests saved API/local connections with a real prompt, and opens a one-stage session through Use model.
- Ollama was verified through the browser UI, connection save, HTTP adapter, pipeline completion and visible answer. Hosted API adapters still require validation with the user's own API keys; automated tests exercise both protocol formats.
- A recovered Claude tool denial now appears as a review note instead of discarding a successful result. Provider permissions remain in place.
- The Windows installer was rebuilt. Public release, macOS signing/build validation and hosted-key account testing remain pending.

## 2.2.0: Night Shift redesign and working pipelines (2026-09-25)

- One dark "Night Shift" design across the whole app, replacing the light workbench layered over the old dark UI. Local Inter and JetBrains Mono fonts; no network needed.
- Fixed: broadcasting a prompt crashed silently in 2.1.0 (a removed `TRUST_DIALOG` definition) and locked the deck for 10 minutes.
- Pipelines: live activity log per stage (Claude and Grok stream JSON, Codex `--json`), per-stage instructions, stronger Plan/Build/Review briefs, approve with a note, edit the handoff, redo a stage, retry a failed stage, auto-approve, 15/30 minute stage timeouts, run history.
- Grok read-only stages are limited to file reading tools, since Grok's plan mode cancels the whole run on a blocked command. Grok answers now come from its final result instead of the first line of plain output.
- Panes no longer start in the home folder. A first-run screen asks for a project folder, with a native folder picker in the desktop app.
- Cards over panes explain when a CLI is waiting on the user (folder trust, Codex update, sign-in).
- Pane headers are one row with a menu; the "-> sidecar" action from the July branch is back.
- History and Connections are full pages. Provider cards show CLI install status and version.
- Removed the old pane-driven pipeline code and old-format pipeline templates.

Verified 2026-09-25 on Windows: `npm test` (16 tests, 42 extraction assertions) passed; a headless UI pass covered every page and a full API pipeline (run, approve with note, finish, History) with no console errors; a live Codex -> Claude -> Grok run in a temp folder produced the exact file and a SHIP IT review in 51 seconds.

## 2.2.1: real models, real answers (2026-09-25)

- Models: one catalog (`lib/models.js`) named the way each CLI's own /model menu names them (Opus 5.5, Fable 5.1, Sonnet 5, Haiku 4.5, Opus 5, Fable 5, Opus 4.8 to 4.6; GPT-6-Astra/Sol/Luna, GPT-5.6-Sol/Terra/Luna, GPT-5.5; Grok 4.7, 4.7 Fast, 4.6, 4.5). Every ID was run live and the CLI reported running on exactly that model. The old list held shortcut names ("opus") and stale Codex IDs.
- Panes launch with the saved model and effort flags, so the pane chip shows what the pane really runs. Changing it restarts the pane and resumes the same conversation (`claude --resume`, `codex resume`, `grok --resume`). Claude and Grok panes launch with `--session-id`, so each pane's conversation log is known exactly.
- Nothing typed into CLI menus anymore: typing `/model` into Claude had changed the account's default model. Grok's interactive screen saves any `--model` as the user's default; VibeDeck restores the user's own default right after.
- Answers come from each CLI's conversation log (`lib/transcripts.js`), with exact text, the model that wrote it, and the CLI's own "finished" signal (interrupts, API errors and aborted turns count as finished; a 90 second silence net covers the rest). Rounds settle in seconds instead of guessing from the screen. Terminal scraping is only a fallback.
- Pipelines: per-stage effort, "Can run commands" switch for Claude and Grok Build stages, and every stage shows the model it ran on. Grok Build without the switch gets file tools only, because Grok ends the run when a blocked command is tried.
- CLIs start with a clean environment (no `CLAUDECODE` / `CLAUDE_CODE_*` from a parent Claude Code session, no `ELECTRON_RUN_AS_NODE`).
- Fixes: Codex judge (needed `--skip-git-repo-check`), CLI paths with spaces, the "still answering" check (lost its backslashes), relay/Notes/Sidecar sending an older answer, panes restarted mid-round hanging the round, stale waiting cards after restarts and folder switches, Codex trust prompt detection, judge and Notes running inside the app folder (breaks in the packaged app).
