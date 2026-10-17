# VibeDeck

A local desktop workbench for AI coding tools. Run Claude Code, Codex and Grok side by side, send one prompt to all of them, compare the answers, and chain them into reviewed pipelines. Windows and macOS packaging is included; the public product page is planned at https://dbtech45.com/vibedeck.

## Run it

Setting up on a new PC? Follow **[INSTALL.md](INSTALL.md)** for the full step-by-step guide.

Install Node.js 22 or newer. On Windows, double-click `VibeDeck.bat` (it installs packages the first time). Or:

```sh
npm ci
npm run desktop
```

VibeDeck bundles its own desktop runtime in installers. The AI CLIs are separate: install and sign in to Claude Code, Codex CLI or Grok before using them. Provider subscriptions and usage charges are separate.

For browser development, `npm start` prints a private localhost session link. Open that exact link; the bare localhost URL intentionally rejects unauthenticated requests.

## First run

Pick a project folder. Terminals and pipelines only start inside a real project folder, never your whole user folder. The desktop app has a native Browse button; browser mode takes a pasted path.

Or clone one: **Clone from Git** (on the start screen and in the Project folder menu) takes an https or ssh repo link, a folder to put it in and a folder name (filled in from the link), clones it with live progress and opens it. It never writes into a folder that already has files, Cancel removes the half-made folder, and private repos use the git sign-in already on the machine.

## Workbench

- Up to five real terminal panes. Each pane header has a model chip, a live timer while it answers, a Broadcast on/off toggle, and a menu (send the answer to Notes or Sidecar, relay it to another pane, switch CLI, move, restart, close).
- The model chip shows the model and effort the pane was launched with (for example "Opus 5.5 · High"). Picking a new one restarts that pane with the CLI's own `--model` / effort flags and resumes the same conversation (`claude --resume`, `codex resume`, `grok --resume`), so the model is guaranteed and nothing is typed into the CLI's menus or changes its global default. The pick is remembered per CLI for new panes. Model names and IDs live in `lib/models.js`; the refresh button re-reads each CLI's list.
- The prompt at the bottom goes to every pane with Broadcast on. Enter sends, Shift+Enter adds a line, Up/Down recalls earlier prompts.
- When a CLI is stuck on a question only you should answer (Claude's or Codex's folder-trust prompt, a Codex update prompt, a sign-in screen), a card over the pane says so and prompts wait until it's answered. VibeDeck never answers these for you.
- Answers are read from each CLI's own conversation log (`~/.claude/projects`, `~/.codex/sessions`, `~/.grok/sessions`), not scraped from the terminal. That gives the exact text, the model that really wrote it, and a reliable "finished" signal for the round. Terminal scraping remains only as a fallback.
- Compare shows every answer from the last round side by side, labeled with the model that wrote it. Pick a winner, continue from an answer, or ask a blind AI judge.
- Your prompts are highlighted inside each pane (a colored band plus a mark on the pane's scrollbar), whether they came from the prompt box or were typed or pasted straight into the pane. Ctrl+Shift+Up and Ctrl+Shift+Down jump to the previous or next one. Pick the color, strength or Off in Settings (gear in the title bar, or Ctrl+,).
- When an answer finishes, its two parts get their own look: the steps where the AI shows its work (files read, commands run, progress notes) and the summary it ends with. The summary is found by its exact text in the CLI's own log, so lines that can't be matched are left alone. Pick Fade the work (default), Two colors, Summary card or Off, plus the summary and work colors, in Settings. It works for prompts from the prompt box and for prompts typed straight into a pane, on Claude, Codex and Grok, including Claude's full-screen view.
- Ctrl+V and Shift+Insert paste into a pane the way Windows Terminal does, so dictation apps that paste with Ctrl+V (Wispr Flow and similar) type straight into the CLI. Pasted images are saved and their path is typed in.
- Web links in a pane's output, including `http://localhost:...`, are underlined on hover and open in your default browser on click. Only http and https links open.
- CLIs start with a clean environment: variables from a parent Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_*`) and Electron's `ELECTRON_RUN_AS_NODE` are removed, so launching VibeDeck from inside Claude Code doesn't change how the panes behave.

## Review and checkpoints

- VibeDeck saves a checkpoint of the project folder when it opens, and again before every broadcast, relay, pipeline run and prompt typed straight into an AI pane. Checkpoints live in a private git repository in VibeDeck's data folder (`data/checkpoints`). The project's own `.git`, branches and history are never touched, and folders that are not git repos work the same way.
- The Review page lists every file changed since the last reviewed checkpoint, with +/- counts, and shows each file as red and green blocks. Each block has Keep and Undo. Keep accepts it; Undo writes the old lines back to disk. Keep all, Undo all, Keep file and Undo file cover bigger steps.
- The checkpoint timeline can review everything since any checkpoint, or Rewind the whole project to it. Undo and Rewind save a checkpoint first, so they can be reversed too.
- Keys on the Review page: J and K move between changes, Shift+J and Shift+K between files, Y keeps, N undoes, Ctrl+Enter keeps everything.
- Left out of checkpoints: anything the project's `.gitignore` ignores (so `.env` files), generated folders such as `node_modules`, `dist`, `build` and `.next`, and large media and archive files.

## Pipelines

Build a chain of one to eight stages. Each stage picks a role, a provider, a model and effort (named as each CLI names them, like "Opus 5.5" or "GPT-6-Sol"), and optional instructions. Every finished stage shows the model the CLI reported actually running on, and flags it if that differs from the pick.

- **Plan**: reads the project and writes a plan. No file changes.
- **Build**: makes the file changes.
- **Review**: checks the actual project state against the request and ends with SHIP IT or NEEDS WORK. No file changes.

Providers are Claude, Codex or Grok CLIs, or a saved API/local connection. Starters ship in `pipelines/*.json`; save your own from the builder.

While a stage runs you see a live activity log (files read and edited, commands run) and a timer. When it finishes the run pauses for you: read the answer, then approve, add a note for the next stage, edit what gets handed on, or redo the stage. Turn on auto-approve to run straight through. A failed stage can be retried. Stop kills the active process tree. Finished runs are kept on the History page with every stage's answer.

How each CLI runs:

| Provider | Plan / Review | Build | Build with "Can run commands" |
|---|---|---|---|
| Codex | `codex exec --json --sandbox read-only` | `--sandbox workspace-write` (runs commands inside Codex's sandbox) | same |
| Claude | `claude -p --output-format stream-json --permission-mode plan` | `--permission-mode acceptEdits` (commands denied, noted at the handoff) | `--permission-mode bypassPermissions` |
| Grok | `--output-format streaming-messages-json --permission-mode plan --tools read_file,list_dir,grep` | `--permission-mode acceptEdits --tools read_file,list_dir,grep,write,search_replace` | `--permission-mode bypassPermissions` |

Model and effort add `--model` / `-m` and `--effort`, `--reasoning-effort` or `-c model_reasoning_effort=`. Grok's tool lists matter: Grok stops the whole run the moment its permission mode blocks a tool, so each stage only gets tools it may use. "Can run commands" is off by default; turn it on for a Build stage that should run tests, installs or builds without asking.

Prompts go through stdin or a private temp file, never a shell. API stages receive only the prompt and earlier outputs; they return text and never touch files. Plan and Review time out after 15 minutes, Build after 30.

## Usage meters

The sidebar shows a bar under each AI, and Connections shows every limit window with its reset time. The numbers come from the CLIs themselves: Claude from its own `/usage` report (a local command, no model call), Codex from the rate limits it records in its session logs, Grok from the usage files it writes per session. Grok reports no plan limit, so its bar compares today with the busiest day of the last week. Bars turn amber at 60% and red at 85%.

The Token meter (gauge button in the top bar) shows today's tokens per AI and what they would cost at list prices (plans are flat, so this is value, not a bill). Claude counts helper-agent transcripts too and is priced per model; Codex counts only the part of a session used today; Grok uses its own per-turn usage records. To check it against an independent recount of the raw logs:

```sh
npm run meter:check                       # today
npm run meter:check -- --date 2026-10-09  # a past day
npm run meter:check -- --plan             # also print each CLI's own plan-limit report
```

## Hands-free runs

The Hands-free switch on the Request box runs every pipeline stage straight through without stopping for approval, and lets Claude and Grok Build stages run commands (tests, installs, builds) without being blocked. Plan and Review stages stay read-only.

## History

Three tabs: pipeline runs (open one to read every stage, copy it, or run it again), broadcast rounds (reopen any round in Compare), and prompts.

## Connections

Provider cards show whether each CLI is installed and its version, with a Sign in button that opens that provider's own login in a terminal pane. API and local connections cover Grok/xAI, OpenAI, Anthropic, Ollama, LM Studio and custom compatible endpoints. Test sends a small real prompt. "Use in a pipeline" opens a one-stage pipeline with that model.

API keys are session-only by default. The desktop app can remember them using Electron safeStorage backed by the operating system. Keys are never sent back to the page. Changing a connection's destination requires entering the key again. Hosted endpoints require HTTPS; local loopback endpoints may use HTTP without a key. Redirects are rejected.

## Local data and protection

Desktop profiles live in Electron's per-user application-data directory; source-mode profiles live beside `server.js`. Saved rounds, pipeline runs, pipelines, notes and pasted images stay local. The CLIs send prompts and relevant project context to their providers.

The engine binds only to loopback, uses a random per-launch session, validates HTTP hosts and WebSocket origins, and keeps provider permission prompts. Electron uses a sandboxed renderer with Node integration disabled. Closing the app shuts down its engine and terminal processes.

## Tests and packaging

```sh
npm test                       # extraction fixtures + runner, adapter and server tests
node test/live-pipeline.cjs    # opt-in: real Codex -> Claude -> Grok run in a temp folder (uses your accounts)
npm run dist:win               # Windows installer (unsigned)
npm run dist:mac               # build on macOS
```

Build macOS packages on macOS. Installers are unsigned validation builds until signing credentials are configured. See [RELEASE.md](RELEASE.md).
