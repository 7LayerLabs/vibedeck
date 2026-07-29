#!/usr/bin/env node
// test/extract-fixtures.js — fixture suite for lib/screen.js extraction.
// Plain node, no framework. `npm test` (or `node test/extract-fixtures.js`).
//
// Exit 0 when every assertion passes, 1 on any failure. Gap probes (things that
// arguably should be filtered but currently are not) print as WARN and never
// change the exit code — see test/fixtures.js for why.

const { stripAnsi, segmentAnsi, cleanTui, extractAnswer } = require('../lib/screen');
const fixtures = require('./fixtures');

let failures = 0;
let checks = 0;
const warnings = [];

function fail(label, detail) {
  failures++;
  console.log(`FAIL  ${label}`);
  if (detail) console.log(`      ${detail}`);
}

function pass(label) {
  console.log(`ok    ${label}`);
}

function check(cond, label, detail) {
  checks++;
  if (cond) return true;
  fail(label, detail);
  return false;
}

function countOf(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) { n++; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

function show(s, max = 220) {
  const one = JSON.stringify(s);
  return one.length > max ? one.slice(0, max) + '…"' : one;
}

// ---------------------------------------------------------------------------
// Unit assertions: segmentAnsi must not fuse words across cursor moves.
// ---------------------------------------------------------------------------
console.log('-- segmentAnsi units --');

{
  const label = 'segmentAnsi: cursor-forward becomes a space';
  const got = segmentAnsi('A\x1b[1Cgreat\x1b[1CTUI');
  if (check(got.includes('A great TUI'), label, `got ${show(got)}`)) pass(label);
}

{
  const label = 'segmentAnsi: multi-column forward collapses to one space';
  const got = segmentAnsi('one\x1b[5Ctwo\x1b[12Cthree');
  if (check(got === 'one two three', label, `got ${show(got)}`)) pass(label);
}

{
  const label = 'segmentAnsi: cursor positioning becomes a newline';
  const got = segmentAnsi('top\x1b[3;1Hbottom\x1b[Amiddle');
  const lines = got.split('\n').map(s => s.trim()).filter(Boolean);
  if (check(
    lines.join('|') === 'top|bottom|middle',
    label,
    `got ${show(got)}`
  )) pass(label);
}

{
  // The reason segmentAnsi exists at all: plain stripAnsi fuses the words.
  const label = 'stripAnsi alone fuses words (regression guard on the motivation)';
  const got = stripAnsi('A\x1b[1Cgreat\x1b[1CTUI');
  if (check(got === 'AgreatTUI', label, `got ${show(got)}`)) pass(label);
}

// ---------------------------------------------------------------------------
// Fixture assertions.
// ---------------------------------------------------------------------------
console.log('\n-- fixtures --');

for (const fx of fixtures) {
  const before = failures;
  let out;
  try {
    out = extractAnswer(fx.raw, fx.prompt);
  } catch (err) {
    fail(fx.name, `extractAnswer threw: ${err && err.stack}`);
    continue;
  }

  checks++;
  if (typeof out !== 'string') {
    fail(fx.name, `extractAnswer returned ${typeof out}, expected string`);
    continue;
  }

  const lower = out.toLowerCase();
  const lines = out.split('\n').map(l => l.trim());

  if (!fx.allowEmpty) {
    check(out.length > 0, `${fx.name}: output is non-empty`, `got ${show(out)}`);
  }

  for (const want of fx.mustContain || []) {
    check(
      lower.includes(want.toLowerCase()),
      `${fx.name}: contains ${show(want)}`,
      `output was ${show(out)}`
    );
  }

  for (const bad of fx.mustNotContain || []) {
    check(
      !lower.includes(bad.toLowerCase()),
      `${fx.name}: omits ${show(bad)}`,
      `output was ${show(out)}`
    );
  }

  for (const badLine of fx.mustNotBeLine || []) {
    check(
      !lines.some(l => l.toLowerCase() === badLine.toLowerCase()),
      `${fx.name}: no standalone partial-paint line ${show(badLine)}`,
      `output was ${show(out)}`
    );
  }

  for (const once of fx.onceOnly || []) {
    const n = countOf(lower, once.toLowerCase());
    check(
      n === 1,
      `${fx.name}: ${show(once)} appears exactly once`,
      `appeared ${n} times; output was ${show(out)}`
    );
  }

  // Universal: no line of any extracted answer may be obvious TUI chrome.
  const chrome = lines.filter(l => /esc to interrupt/i.test(l));
  check(
    chrome.length === 0,
    `${fx.name}: no chrome lines survive`,
    `chrome lines: ${show(chrome.join(' / '))}`
  );

  for (const probe of fx.gapProbes || []) {
    for (const bad of probe.mustNotContain) {
      if (lower.includes(bad.toLowerCase())) {
        warnings.push({
          fixture: fx.name,
          label: probe.label,
          detail: `${show(bad)} survived extraction; output was ${show(out)}`,
        });
      }
    }
  }

  if (failures === before) pass(fx.name);
}

// ---------------------------------------------------------------------------
console.log('');
if (warnings.length) {
  console.log(`-- ${warnings.length} known gap${warnings.length === 1 ? '' : 's'} (non-fatal) --`);
  for (const w of warnings) {
    console.log(`WARN  ${w.fixture}: ${w.label}`);
    console.log(`      ${w.detail}`);
  }
  console.log('');
}

if (failures) {
  console.log(`${failures} of ${checks} assertions FAILED`);
  process.exit(1);
}
console.log(`All ${checks} assertions passed across ${fixtures.length} fixtures.`);
process.exit(0);
