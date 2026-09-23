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
