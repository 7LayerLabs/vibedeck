# VibeDeck

A local desktop workbench for AI coding tools. Windows and macOS packaging is included; the public product page is planned at https://dbtech45.com/vibedeck.

## Desktop development

Install Node.js 22 or newer, then:

```sh
npm ci
npm run desktop
```

VibeDeck bundles its own desktop runtime in installers. AI CLIs are separate: install and authenticate Claude Code, Codex CLI, or Grok before using their terminals. Provider subscriptions and usage charges are separate. Model access depends on your provider account and CLI version.

For browser development, `npm start` prints a private localhost session link. Open that exact link; the bare localhost URL intentionally rejects unauthenticated requests.

## Workbench

- Up to five real terminal panes, with shared prompts, compare, relay, notes and saved rounds.
- Native CLI permission and project-trust prompts stay enabled. VibeDeck does not accept them automatically.
- The sidebar switches project folders and opens saved rounds or the pipeline builder.
- Terminal broadcasts share a project directory. Use them for comparing approaches; avoid approving conflicting edits in multiple terminals at once.

## Configurable pipelines

Choose one to eight Plan, Build or Review stages. Each stage independently selects Claude or Codex and an optional model ID. For example: Codex `gpt-6-astra` plans, Claude builds, and Codex reviews. An empty model uses the installed CLI's default. Grok remains available in terminals; automated Grok stages are not supported by this runner.

Save named pipelines locally, enter your request, and run. Each stage is a separate noninteractive CLI process. The runner uses process exit status and the final answer, not terminal silence, to decide completion. It passes prior outputs to the next stage through stdin. Review each answer and approve the next stage explicitly. Stop terminates the active process tree and drops remaining stages. Failures, denied Claude permissions and timeouts halt the chain.

Codex Plan/Review use the read-only sandbox; Build uses workspace-write. Claude uses plan/acceptEdits permission modes respectively. Provider policy restrictions still apply. Choose a project folder before starting a pipeline.

## Local data and connection protection

Desktop profiles live in Electron's per-user application-data directory. Source-mode profiles remain beside `server.js`. Saved rounds, pipelines, notes and pasted images are local. Selected CLIs transmit prompts and relevant project context to their providers.

The engine binds only to loopback, uses a random per-launch authenticated session, validates HTTP hosts and WebSocket origins, and retains provider permission prompts. Electron uses a sandboxed renderer with Node integration disabled. Closing the desktop application shuts down its engine and terminal processes.

## Validation and packaging

```sh
npm test
npm run dist:win
node test/packaged-smoke.cjs
npm run dist:mac
```

Build macOS packages on macOS. GitHub Actions builds Windows x64, macOS Apple silicon and macOS Intel artifacts. These are unsigned validation artifacts until signing credentials are configured. A successful package build alone is not proof of a signed or notarized public release.

See [RELEASE.md](RELEASE.md) for current validation and release requirements.
