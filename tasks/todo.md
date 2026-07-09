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
