#!/bin/zsh
# macOS launcher — double-click to start VibeDeck and open it in your browser.
# (first run: right-click > Open, or run `chmod +x VibeDeck.command` in Terminal)
cd "$(dirname "$0")"
(sleep 2 && open http://localhost:18801) &
node server.js
