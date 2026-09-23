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

Choose one to eight Plan, Build or Review stages. Each stage independently selects Claude, Codex, Grok, or a saved API/local connection and an optional model ID. For example: Codex `gpt-6-astra` plans, Claude builds, and Codex reviews. An empty model uses the installed CLI's default. Grok CLI stages require a version supporting --prompt-file and --permission-mode. API stages use Anthropic Messages or OpenAI-compatible chat completions.

Save named pipelines locally, enter your request, and run. CLI stages run as separate noninteractive processes; API stages make cancellable requests to the configured endpoint. The runner uses process exit status and the final answer, not terminal silence, to decide completion. It passes prior outputs to the next stage through stdin. Review each answer and approve the next stage explicitly. Stop terminates the active process tree and drops remaining stages. Failures, denied Claude permissions and timeouts halt the chain.

Codex Plan/Review use the read-only sandbox; Build uses workspace-write. Claude uses plan/acceptEdits permission modes respectively. Provider policy restrictions still apply. Choose a project folder before starting a pipeline with CLI stages. API stages receive only the supplied prompt and preceding outputs; they return text/proposed code and cannot access or edit project files.

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

## Connections

The Connections view separates supported provider CLI sign-in from API credentials. CLI subscription eligibility follows the provider account; VibeDeck does not convert subscription tokens into API keys. API charges remain separate.

Presets cover Grok/xAI, OpenAI, Anthropic, Ollama and LM Studio, plus custom compatible endpoints. Model IDs are supplied by the user. Hosted endpoints require HTTPS; local loopback endpoints may use HTTP without a key. Redirects are rejected to avoid forwarding credentials to another destination.

API keys are session-only by default. The desktop app can remember them using Electron safeStorage backed by the operating system. Keys are excluded from connection metadata and all renderer responses. Changing the destination requires entering a key again. In browser development, encrypted persistence is disabled.

Provider adapters are fixture-tested. Actual account/model access, local-model availability and live CLI-version compatibility still require release validation.

### Verify your connection

In **Connections**, use **Sign in** to open an installed provider's own CLI login flow. After login, open its terminal or select it in a pipeline. For API/local models, save the endpoint and exact chat model ID, then click **Test connection** (a small real request using normal provider usage). **Use model** opens a one-stage pipeline ready for your prompt. Add stages to mix providers. API/local stages produce text and proposed code; CLI stages can operate on project files with provider permissions.

For an opt-in live Codex → Claude → Grok integration check, run `node test/live-pipeline.cjs`. It uses existing account sign-ins and a disposable temporary project.
