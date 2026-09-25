'use strict';
// Model and effort choices per CLI, named the way each CLI's own /model menu names them.
// Every ID here was run through the real adapters on 2026-09-25 and the CLI reported
// running on exactly that model (grok reports its "-build" coding variant of the same model).
// "Update models" refreshes these lists from the CLIs; this file is the starting point.

const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultra: 'Ultra' };

const CATALOG = {
  claude: {
    models: [
      ['claude-opus-5-5', 'Opus 5.5'], ['claude-fable-5-1', 'Fable 5.1'], ['claude-sonnet-5', 'Sonnet 5'],
      ['claude-haiku-4-5', 'Haiku 4.5'], ['claude-opus-5', 'Opus 5'], ['claude-fable-5', 'Fable 5'],
      ['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7'], ['claude-opus-4-6', 'Opus 4.6'],
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultLabel: 'Opus 5.5',
  },
  codex: {
    models: [
      ['gpt-6-astra', 'GPT-6-Astra'], ['gpt-6-sol', 'GPT-6-Sol'], ['gpt-6-luna', 'GPT-6-Luna'],
      ['gpt-5.6-sol', 'GPT-5.6-Sol'], ['gpt-5.6-terra', 'GPT-5.6-Terra'], ['gpt-5.6-luna', 'GPT-5.6-Luna'], ['gpt-5.5', 'GPT-5.5'],
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultLabel: 'GPT-6-Astra',
  },
  grok: {
    models: [['grok-4.7', 'Grok 4.7'], ['grok-4.7-build-fast', 'Grok 4.7 Fast'], ['grok-4.6', 'Grok 4.6'], ['grok-4.5', 'Grok 4.5']],
    efforts: ['low', 'medium', 'high'],
    defaultLabel: 'Grok 4.5',
  },
};

// The shape the UI uses: { kind: { models: [id], efforts: [id], labels: {id: label}, defaultLabel } }
function defaultModels() {
  const out = {};
  for (const [kind, c] of Object.entries(CATALOG)) {
    out[kind] = {
      models: c.models.map(m => m[0]),
      efforts: [...c.efforts],
      labels: Object.fromEntries([...c.models, ...c.efforts.map(e => [e, EFFORT_LABELS[e]])]),
      defaultLabel: c.defaultLabel,
    };
  }
  return out;
}

// Readable name for a model ID the catalog doesn't know yet, e.g. grok-4.8 -> Grok 4.8.
function labelFor(kind, id) {
  if (kind === 'claude') {
    const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d+))?/);
    if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] && m[3].length < 3 ? '.' + m[3] : ''}`;
  }
  if (kind === 'codex') return id.replace(/^gpt/i, 'GPT').replace(/-([a-z])/g, (_, c) => '-' + c.toUpperCase());
  if (kind === 'grok') return id.replace(/^grok-/, 'Grok ').replace(/-build-fast$/, ' Fast').replace(/-/g, ' ');
  return id;
}

// Turn the text painted by a CLI's /model menu into [id, label] pairs.
function parseMenu(kind, painted) {
  const seen = new Map();
  if (kind === 'claude') {
    for (const m of painted.matchAll(/\d+\.\s*(Opus|Fable|Sonnet|Haiku)\s*(\d+(?:\.\d+)?)/g)) {
      const id = `claude-${m[1].toLowerCase()}-${m[2].replace('.', '-')}`;
      seen.set(id, `${m[1]} ${m[2]}`);
    }
  } else if (kind === 'codex') {
    for (const m of painted.matchAll(/\d+\.\s*(GPT-[0-9][\w.]*(?:-[A-Za-z][a-z]+)?)/g)) seen.set(m[1].toLowerCase(), m[1]);
  }
  return [...seen.entries()];
}

module.exports = { CATALOG, EFFORT_LABELS, defaultModels, labelFor, parseMenu };
