// test/fixtures.js — raw PTY capture fixtures for lib/screen.js extraction.
//
// Each fixture is a realistic-ish byte stream from an Ink-based AI CLI TUI.
// `raw` uses real escape sequences (\x1b) so the fixtures exercise the same
// code paths as live PTY output.
//
// Fixture shape:
//   name            label printed by the runner
//   raw             the fake PTY byte stream
//   prompt          the prompt that was sent (drives echo suppression)
//   mustContain     substrings that MUST survive extraction (case-insensitive)
//   mustNotContain  substrings that MUST NOT appear anywhere in the output
//   mustNotBeLine   exact lines that MUST NOT appear as their own output line.
//                   Needed for partial-paint fragments: a truncated repaint like
//                   "The rollback path is" is a SUBSTRING of the completed line,
//                   so only a line-level assertion can catch it.
//   onceOnly        substrings that must appear exactly once (repaint dedupe)
//   allowEmpty      output legitimately may be '' (see short-answer fixture)
//   gapProbes       [{ label, mustNotContain }] — things that arguably SHOULD be
//                   filtered but currently are not. Reported as warnings by the
//                   runner, never as failures, so the suite never silently
//                   encodes buggy behavior as "expected".

const BOX_TOP = '╭────────────────────────────────────────────╮';
const BOX_BOT = '╰────────────────────────────────────────────╯';

// ---------------------------------------------------------------------------
// 1. claude-like: full screen repaints, box chrome, cursor-forward "spaces",
//    prompt echo inside the input box, and partial-paint prefix fragments.
// ---------------------------------------------------------------------------
const claudePrompt = 'Summarize the deploy plan in three sentences.';

const claudeRaw =
  '\x1b[2J\x1b[H' +
  `${BOX_TOP}\n` +
  `│ > ${claudePrompt}   │\n` +
  `${BOX_BOT}\n` +
  '\x1b[2m✻ Cogitating… (esc to interrupt · ↓ 235 tokens)\x1b[0m\n' +
  // first paint: truncated fragments the TUI has not finished drawing yet
  'The\x1b[1Cdeploy\x1b[1Cplan\x1b[1Cships\x1b[1Cthe\x1b[1CAPI\x1b[1Cfir\n' +
  'The rollback path is\n' +
  // repaint: cursor home + full screen redraw, this time complete
  '\x1b[2J\x1b[1;1H' +
  `${BOX_TOP}\n` +
  `│ > ${claudePrompt}   │\n` +
  `${BOX_BOT}\n` +
  '\x1b[1mThe\x1b[1Cdeploy\x1b[1Cplan\x1b[1Cships\x1b[1Cthe\x1b[1CAPI\x1b[1Cfirst.\x1b[0m\x1b[8;1H' +
  'Database migrations run behind a feature flag so the two halves can land out of order.\x1b[9;1H' +
  'The rollback path is a single toggle in the dashboard.\x1b[10;1H' +
  // a repeated line from an earlier paint — must be deduped, not doubled
  'Database migrations run behind a feature flag so the two halves can land out of order.\n' +
  '\x1b[2m⏵⏵ bypass permissions on (shift+tab to cycle)\x1b[0m\n' +
  '\x1b[2m✻ Cogitated for 7s\x1b[0m\n';

// ---------------------------------------------------------------------------
// 2. codex-like: simpler stream, SGR colors, "› " prompt marker, numbered list.
// ---------------------------------------------------------------------------
const codexPrompt = 'List three checks before merging.';

const codexRaw =
  '\x1b[2m› \x1b[0m' + codexPrompt + '\n' +
  '\x1b[90m───────────────────────────────\x1b[0m\n' +
  '\x1b[32m✔\x1b[0m Here are the three checks I would run:\n' +
  '\x1b[1m1.\x1b[0m Run the unit suite against the merge base.\n' +
  '\x1b[1m2.\x1b[0m Check the bundle size delta stays under two kilobytes.\n' +
  '\x1b[1m3.\x1b[0m Confirm the migration is reversible on a copy of prod.\n' +
  '\x1b[2m✻ Working… (esc to interrupt)\x1b[0m\n' +
  '\x1b[2mtokens used: 1,234\x1b[0m\n';

// ---------------------------------------------------------------------------
// 3. short answer buried in chrome.
//    NOTE: cleanTui legitimately returns '' here. Its line filter drops any line
//    without 3+ consecutive letters ("spinner shrapnel"), which also eats "4"
//    and "2 + 2 = 4." That is deliberate — cleanTui doubles as the settle signal
//    in server.js, and server.js has a quiet-done fallback for exactly this
//    case. So this fixture only asserts extractAnswer does not crash, returns a
//    string, and leaks no chrome.
// ---------------------------------------------------------------------------
const shortPrompt = 'What is 2 + 2?';

const shortRaw =
  '\x1b[2J\x1b[H' +
  `${BOX_TOP}\n` +
  `│ > ${shortPrompt}  │\n` +
  `${BOX_BOT}\n` +
  '\x1b[2m✻ Cogitating… (esc to interrupt · ↓ 12 tokens)\x1b[0m\n' +
  '\x1b[1m2 + 2 = 4.\x1b[0m\n' +
  '\x1b[2m⏵⏵ bypass permissions on (shift+tab to cycle)\x1b[0m\n';

// ---------------------------------------------------------------------------
// 4. prefix fragments vs. genuinely short lines.
//    "Verdict: Conce" must be dropped because a later line strictly extends it.
//    "Yes." must SURVIVE even though a later line also starts with "Yes" —
//    normalized keys under 6 chars are exempt from the supersede rule.
// ---------------------------------------------------------------------------
const prefixPrompt = 'Give me your call on the concept.';

const prefixRaw =
  'Verdict: Conce\n' +
  'Yes.\n' +
  'Verdict: Concept approved, ship it\n' +
  'Yes, the migration is reversible and cheap to undo.\n';

module.exports = [
  {
    name: 'claude-like screen repaint',
    raw: claudeRaw,
    prompt: claudePrompt,
    mustContain: [
      'The deploy plan ships the API first.',
      'Database migrations run behind a feature flag',
      'The rollback path is a single toggle in the dashboard.',
    ],
    mustNotContain: [
      // cursor-forward must become a space, not vanish and fuse the words
      'deployplan',
      'shipsthe',
      'bypass permissions',
      'esc to interrupt',
      'Cogitated for 7s',
      // the prompt echo inside the input box
      'Summarize the deploy plan in three sentences',
    ],
    mustNotBeLine: [
      'The deploy plan ships the API fir',
      'The rollback path is',
    ],
    onceOnly: [
      'Database migrations run behind a feature flag',
    ],
  },
  {
    name: 'codex-like colored stream',
    raw: codexRaw,
    prompt: codexPrompt,
    mustContain: [
      'Here are the three checks I would run',
      '1. Run the unit suite against the merge base.',
      '2. Check the bundle size delta stays under two kilobytes.',
      '3. Confirm the migration is reversible on a copy of prod.',
    ],
    mustNotContain: [
      'esc to interrupt',
      '\x1b',
      '[32m',
      'List three checks before merging',
    ],
    gapProbes: [
      {
        label: 'codex "tokens used: N" footer is not matched by CHROME_LINE',
        mustNotContain: ['tokens used'],
      },
    ],
  },
  {
    name: 'short answer buried in chrome',
    raw: shortRaw,
    prompt: shortPrompt,
    allowEmpty: true,
    mustContain: [],
    mustNotContain: [
      'esc to interrupt',
      'bypass permissions',
      'What is 2 + 2',
    ],
  },
  {
    name: 'prefix fragments vs short lines',
    raw: prefixRaw,
    prompt: prefixPrompt,
    mustContain: [
      'Verdict: Concept approved, ship it',
      'Yes.',
      'Yes, the migration is reversible and cheap to undo.',
    ],
    mustNotContain: [],
    mustNotBeLine: [
      'Verdict: Conce',
    ],
  },
];
