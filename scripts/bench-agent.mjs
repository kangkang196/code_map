// Aggregate paired Codex task records. See docs/m2-acceptance.md for the input contract.
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../bench/agent-tasks', import.meta.url));
const requiredKinds = { defect: 8, feature: 6, impact: 6 };
const counters = [
  'input_tokens', 'output_tokens', 'maintenance_tokens', 'wrong_locations',
  'source_bytes_read', 'map_query_bytes', 'maintenance_failures', 'duration_ms',
];

class InputError extends Error {}

function readObject(file) {
  try {
    const value = JSON.parse(readFileSync(join(directory, file), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected an object');
    return value;
  } catch (err) {
    throw new InputError(`${file}: ${err.message}`);
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function validCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function readPairs() {
  let files;
  try {
    files = readdirSync(directory).filter((name) => name.endsWith('.json') && name !== 'bootstrap.json').sort();
  } catch (err) {
    throw new InputError(err.message);
  }
  const tasks = new Map();
  const sessions = new Set();
  let settings;
  for (const file of files) {
    const record = readObject(file);
    for (const field of ['task_id', 'model', 'settings_id', 'snapshot_id', 'session_id']) {
      if (typeof record[field] !== 'string' || !record[field].trim()) throw new InputError(`${file}: ${field} must be a nonempty string`);
    }
    if (typeof record.kind !== 'string' || !Object.hasOwn(requiredKinds, record.kind) ||
        !['codemap', 'control'].includes(record.group) || typeof record.success !== 'boolean') {
      throw new InputError(`${file}: invalid kind, group or success flag`);
    }
    for (const field of counters) {
      if (!validCount(record[field])) throw new InputError(`${file}: ${field} must be a nonnegative integer`);
    }
    const totalTokens = record.input_tokens + record.output_tokens;
    if (!validCount(totalTokens) || !totalTokens || !record.duration_ms || record.maintenance_tokens > totalTokens) {
      throw new InputError(`${file}: invalid duration or token totals`);
    }
    if (record.group === 'control' && (record.map_query_bytes || record.maintenance_tokens || record.maintenance_failures)) {
      throw new InputError(`${file}: control run used Code Map`);
    }
    if (sessions.has(record.session_id)) throw new InputError(`${file}: duplicate Codex session`);
    sessions.add(record.session_id);
    settings ??= { model: record.model, settings_id: record.settings_id };
    if (settings.model !== record.model || settings.settings_id !== record.settings_id) {
      throw new InputError(`${file}: model and settings must match all runs`);
    }

    const pair = tasks.get(record.task_id) ?? {};
    if (pair[record.group]) throw new InputError(`${file}: duplicate ${record.group} record for ${record.task_id}`);
    pair[record.group] = { ...record, totalTokens };
    tasks.set(record.task_id, pair);
  }

  const counts = { defect: 0, feature: 0, impact: 0 };
  for (const [id, { control, codemap }] of tasks) {
    if (!control || !codemap) throw new InputError(`${id}: both control and codemap records are required`);
    if (control.kind !== codemap.kind || control.snapshot_id !== codemap.snapshot_id) {
      throw new InputError(`${id}: task kind and source snapshot must match`);
    }
    counts[control.kind]++;
  }
  for (const [kind, count] of Object.entries(requiredKinds)) {
    if (counts[kind] !== count) throw new InputError(`expected ${count} ${kind} pairs, found ${counts[kind]}`);
  }
  return { pairs: [...tasks.values()], counts, settings };
}

function summarize(rows) {
  return {
    success_rate: rows.filter((r) => r.success).length / rows.length,
    wrong_locations: sum(rows.map((r) => r.wrong_locations)),
    total_tokens: sum(rows.map((r) => r.totalTokens)),
    median_total_tokens: median(rows.map((r) => r.totalTokens)),
    median_input_tokens: median(rows.map((r) => r.input_tokens)),
    median_output_tokens: median(rows.map((r) => r.output_tokens)),
    median_maintenance_tokens: median(rows.map((r) => r.maintenance_tokens)),
    median_source_bytes_read: median(rows.map((r) => r.source_bytes_read)),
    median_map_query_bytes: median(rows.map((r) => r.map_query_bytes)),
    median_duration_ms: median(rows.map((r) => r.duration_ms)),
    maintenance_failures: sum(rows.map((r) => r.maintenance_failures)),
  };
}

try {
  const { pairs, counts, settings } = readPairs();
  const { bootstrap_tokens: bootstrapTokens } = readObject('bootstrap.json');
  if (!validCount(bootstrapTokens) || bootstrapTokens === 0) throw new InputError('bootstrap.json: bootstrap_tokens must be a positive integer');
  const control = summarize(pairs.map((p) => p.control));
  const codemap = summarize(pairs.map((p) => p.codemap));
  const checks = {
    success_rate: codemap.success_rate >= control.success_rate,
    no_new_wrong_locations: pairs.every((p) => p.codemap.wrong_locations <= p.control.wrong_locations),
    token_median_reduction: codemap.median_total_tokens <= control.median_total_tokens * 0.8,
    duration_median_increase: codemap.median_duration_ms <= control.median_duration_ms * 1.2,
  };
  const savings = control.total_tokens - codemap.total_tokens;
  const passed = Object.values(checks).every(Boolean);
  const report = {
    records_dir: directory, pairs_by_kind: counts, ...settings, control, codemap, checks, passed,
    token_reduction: 1 - codemap.median_total_tokens / control.median_total_tokens,
    duration_increase: codemap.median_duration_ms / control.median_duration_ms - 1,
    bootstrap_tokens: bootstrapTokens,
    cumulative_net_tokens: savings - bootstrapTokens,
    estimated_break_even_tasks: savings > 0 ? Math.ceil(bootstrapTokens / (savings / pairs.length)) : null,
  };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exitCode = passed ? 0 : 1;
} catch (err) {
  process.stderr.write(`[bench:agent] ${err.message}\nusage: npm run bench:agent -- [records-dir]\n`);
  process.exitCode = err instanceof InputError ? 2 : 4;
}
