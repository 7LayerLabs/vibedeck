'use strict';
// Environment for every CLI VibeDeck starts (terminal panes, pipeline stages, judge, notes).
// VibeDeck is often launched from inside another Claude Code session, and the desktop shell
// runs its engine with ELECTRON_RUN_AS_NODE. Neither may leak into the user's tools:
//  - CLAUDECODE / CLAUDE_CODE_* mark the child as a sub-session (transcripts off, inherited
//    effort) and carry that session's private messaging token.
//  - ELECTRON_RUN_AS_NODE turns Electron apps typed in a shell pane (code, cursor) into plain node.
const STRIP = /^(CLAUDECODE|CLAUDE_CODE_\w+|CLAUDE_PID|CLAUDE_EFFORT|ELECTRON_RUN_AS_NODE)$/i;

function childEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!STRIP.test(key)) env[key] = value;
  return { ...env, ...extra };
}

module.exports = { childEnv, STRIP };
