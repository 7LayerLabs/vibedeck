# VibeDeck

A terminal cockpit for vibe coders. One prompt bar on top, up to four live AI CLI panes below — type once, every model answers at the same time, and each pane stays a fully interactive terminal so you can answer each CLI's questions and permission prompts yourself.

![VibeDeck icon](public/icon.png)

## What it does

- **Broadcast**: type in the top bar, hit Enter, and the prompt is typed into every pane (Claude Code, Codex, Grok — any terminal AI CLI).
- **Project folder switcher**: pick the folder every pane runs in from the header — recents remembered, every pane relaunches there.
- **Panes are real terminals**: xterm.js + a real PTY per pane. Click in and type like normal.
- **1–4 panes**, any mix — including the same CLI more than once (three Claudes, why not).
- **Model / effort dropdowns** per pane: Claude switches in-session via `/model` and `/effort`; Codex and Grok relaunch with `-m` flags (their CLIs can't switch mid-session). Lists live in `models.json`; the **⟳ models** button refreshes them from the CLIs themselves (Grok via `grok models`, Claude/Codex by scraping their `/model` menus) — so new releases show up without touching code.
- **Yolo by default**: every pane launches with its CLI's skip-permissions flag (claude `--dangerously-skip-permissions`, codex `--dangerously-bypass-approvals-and-sandbox`, grok `--always-approve`) — no approval prompts interrupting broadcasts.
- **Images**: drag an image onto a pane or paste one (Ctrl+V) while it's focused — VibeDeck saves it to `data/images/` and types the file path into that CLI's input, ready to submit.
- **Token meter**: a METER pane (pick it from any pane's CLI dropdown) shows today's usage and API-rate cost across all three CLIs — Claude per-model (from `~/.claude` transcripts, cache read/write included), Codex totals + % of your plan window (from its rollout logs), Grok estimated (it logs no token counts). Press 1/2/3 in the pane to toggle sections, or use its "show ▾" knob. Prices live at the top of `meter-cli.js`.
- **Compare**: see each model's answer to the last broadcast side by side, crown a winner, and keep a running tally.
- **Judge**: a headless `claude -p` call rules on the round — winner, what each answer missed, and a merged best take.
- **Relay**: pipe one pane's answer into another pane as its next prompt. Claude plans, Codex builds, Grok reviews.
- **Pipelines**: relay chains that run hands-free. Type a prompt, pick a chain (⛓ dropdown), and the server sequences it — each step's answer feeds the next pane, with a status chip and cancel. Chains are plain JSON in `pipelines/` (`{prompt}` = your prompt, `{output}` = the previous step's answer); two ship by default: plan → build → review and answer → critique → revise.
- **History**: every broadcast is saved; ↑/↓ cycles, the history overlay reloads or deletes entries.
- **Playbooks**: starter prompts as plain markdown files in `playbooks/` — one click inserts them.

## Run it

```
npm install
npm start
```

Then open http://localhost:18801 (or use `VibeDeck.bat`, which starts the server and opens a chromeless Edge app window).

Configure which CLIs are available in the `ROSTER` array at the top of `server.js`.

## Notes

- Windows-first: PTYs via `@lydell/node-pty` (prebuilt binaries, no compile), spawned through `cmd.exe`.
- Broadcasts queue until each pane's input UI has actually painted — fresh CLIs silently eat text sent during startup.
- Claude Code's folder-trust dialog is auto-cleared so it can't swallow your first prompt.

- The landing page lives in `site/` — a single static file, deployable to Vercel/Netlify as-is.
- Press the keyboard icon in the header (or check the help overlay) for all shortcuts.

Built with Claude Code.
