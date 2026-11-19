#!/usr/bin/env node
/**
 * Summarize a `cdkd state show <stack> --json` dump into the per-resource key
 * comparison go-to-k/cdkd#6624 / #6627 decide on: which keys the deploy-time
 * readback (`observedProperties`, written by the provider's
 * `readCurrentState`) holds that the template-recorded `properties` do not.
 *
 * For every resource it prints the top-level keys only the readback holds,
 * and, under each top-level key both sides hold as an object, every nested
 * path only the readback holds (arrays are walked by index) and every path
 * only the template holds. The full values of both sides are kept too, so a
 * value the service rewrote (an action's case, a principal's spelling) is
 * visible.
 *
 * Usage: `node summarize-readback.ts <state-show.json>`; writes JSON to stdout.
 * It reads a local file only and calls no AWS API.
 */
import { readFileSync } from 'node:fs';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const path = process.argv[2];
if (path === undefined) throw new Error('usage: summarize-readback.ts <state-show.json>');
const dump: unknown = JSON.parse(readFileSync(path, 'utf8'));
const state = isRecord(dump) ? dump['state'] : undefined;
if (!isRecord(state) || !isRecord(state['resources'])) {
  throw new Error(`${path} has no state.resources map`);
}

/** Every leaf-or-container path under `v`, as `a.b[0].c`. */
function paths(v: unknown, prefix: string, out: Set<string>): Set<string> {
  if (Array.isArray(v)) {
    v.forEach((item, i) => {
      const p = `${prefix}[${i}]`;
      out.add(p);
      paths(item, p, out);
    });
  } else if (isRecord(v)) {
    for (const [k, item] of Object.entries(v)) {
      const p = prefix === '' ? k : `${prefix}.${k}`;
      out.add(p);
      paths(item, p, out);
    }
  }
  return out;
}

const summary: Record<string, unknown> = {};
for (const [logicalId, rec] of Object.entries(state['resources']).sort(([a], [b]) =>
  a.localeCompare(b)
)) {
  if (!isRecord(rec)) continue;
  const props = isRecord(rec['properties']) ? rec['properties'] : {};
  const observed = rec['observedProperties'];
  const entry: Record<string, unknown> = {
    resourceType: rec['resourceType'],
    provisionedBy: rec['provisionedBy'] ?? null,
    hasObserved: isRecord(observed),
    templateTopKeys: Object.keys(props).sort(),
  };
  if (isRecord(observed)) {
    entry['observedTopKeys'] = Object.keys(observed).sort();
    entry['observedOnlyTopKeys'] = Object.fromEntries(
      Object.keys(observed)
        .filter((k) => !Object.hasOwn(props, k))
        .sort()
        .map((k) => [k, observed[k]])
    );
    const nested: Record<string, unknown> = {};
    for (const k of Object.keys(props).sort()) {
      const t = props[k];
      const o = observed[k];
      if (!isRecord(t) || !isRecord(o)) {
        // One side an object and the other not (a document read back as a
        // JSON string, or not read back at all): keep both values verbatim.
        if (isRecord(t) || isRecord(o)) nested[k] = { shapeMismatch: true, template: t, observed: o };
        continue;
      }
      const tp = paths(t, '', new Set());
      const op = paths(o, '', new Set());
      nested[k] = {
        observedOnlyPaths: [...op].filter((p) => !tp.has(p)).sort(),
        templateOnlyPaths: [...tp].filter((p) => !op.has(p)).sort(),
        template: t,
        observed: o,
      };
    }
    entry['nested'] = nested;
  }
  summary[logicalId] = entry;
}
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
