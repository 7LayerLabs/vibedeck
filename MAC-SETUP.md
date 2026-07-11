# Running VibeDeck on a Mac

One-time setup, about 5 minutes. After this, launching is a double-click.

## 1. Install Node.js

Grab the LTS installer from https://nodejs.org and run it.
(Already have homebrew? `brew install node` works too.)

## 2. Install the AI CLIs you use

Open Terminal (Cmd+Space, type "Terminal"):

```
npm i -g @anthropic-ai/claude-code @openai/codex
```

Grok's CLI is optional — install it if you use it, skip it if not.
Panes for CLIs you don't have will just show an error; switch them to
CLAUDE or SHELL from the pane's dropdown.

## 3. Log in to each CLI once

```
claude
```

Sign in with your normal account (same Claude Max account as the PC —
they share the plan). Then quit with Ctrl+C. Do the same for `codex`.

## 4. Get VibeDeck

```
git clone https://github.com/7LayerLabs/vibedeck
cd vibedeck
npm install
npm start
```

Open http://localhost:18801 in your browser. That's the deck.

## 5. Every time after that

Double-click **VibeDeck.command** in the vibedeck folder — it starts the
server and opens the browser for you.

First time macOS may block it ("unidentified developer"): right-click the
file, choose **Open**, confirm once. If it says permission denied, run
`chmod +x VibeDeck.command` in Terminal from the vibedeck folder.

## Good to know

- Your prompts/history/state stay on each machine — the PC deck and the
  Mac deck are separate cockpits, but both bill the same CLI accounts.
- Panes launch with permissions skipped (the yolo button). Toggle yolo
  off on a pane if you want the CLI to ask before acting.
- To update later: `git pull` in the vibedeck folder, then `npm install`.
