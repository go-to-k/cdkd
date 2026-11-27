/**
 * go-to-k/cdkd#7110: every engine save goes through `withParentInfo` and
 * `redactStateForPersist`. That path writes `outputReferenceProvenance` only
 * for an `outputs` bag it can place: the deploy's baseline, the bag this run
 * resolved, or a fresh read registered with `carryReadOutputs`. Any other bag
 * persists none, so a save that rebuilds its state from a fresh read of the
 * store, without registering the read, erases the stack's output provenance
 * (`persistDropped` did: a later consumer could never be promoted, #4852).
 *
 * This fence makes each save site declare where its `outputs` come from. A new
 * site, or a moved one, fails here until it is classified. A site that writes
 * back a fresh read must call `carryReadOutputs` in its file.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  carryReadOutputs,
  outputReferenceProvenanceFor,
} from '../../../src/deployment/deploy-engine/state-persist.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';

const ROOT = join(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');

type OutputsSource = 'deploy-state' | 'written-back-read';

/** Per file: how many save sites, and where their `outputs` bag comes from. */
const SAVE_SITES: Record<string, { count: number; outputs: OutputsSource }> = {
  // `partialState`, `preRollbackState`, `buildState()`: `currentState.outputs`
  // (the loaded baseline). The retry's fresh read supplies its ETag only.
  'src/deployment/deploy-engine/execute.ts': { count: 4, outputs: 'deploy-state' },
  // The final save: this run's resolved outputs.
  'src/deployment/deploy-engine/deploy-flow.ts': { count: 1, outputs: 'deploy-state' },
  // The no-change refresh: the loaded record's outputs, or this run's.
  'src/deployment/deploy-engine/deploy-flow/no-change.ts': { count: 1, outputs: 'deploy-state' },
  // `postRollbackState`: `currentState.outputs`; the fresh read is for its ETag.
  'src/deployment/deploy-engine/execute/rollback-after-failure.ts': {
    count: 2,
    outputs: 'deploy-state',
  },
  // `persistDropped`: the fresh read, written back without the dropped rows.
  'src/deployment/deploy-engine/nested-cleanup.ts': { count: 1, outputs: 'written-back-read' },
};

/** The definitions, not save sites. */
const DEFINITIONS = new Set([
  'src/deployment/deploy-engine.ts',
  'src/deployment/deploy-engine/state-persist.ts',
]);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...tsFiles(path));
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Call sites of the persist choke point, by repo-relative file. */
function saveSiteCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of tsFiles(SRC)) {
    const text = readFileSync(path, 'utf8');
    const n = (text.match(/\b(?:withParentInfo|redactStateForPersist)\(/g) ?? []).length;
    if (n > 0) counts.set(relative(ROOT, path).split('\\').join('/'), n);
  }
  return counts;
}

describe('engine saves carry output reference provenance (go-to-k/cdkd#7110)', () => {
  it('every save site is classified by where its outputs come from', () => {
    const counts = saveSiteCounts();
    // Floor: the scan reads the real tree, so an empty map means a broken scan.
    expect(counts.size).toBeGreaterThanOrEqual(Object.keys(SAVE_SITES).length);
    const found: Record<string, number> = {};
    for (const [file, n] of counts) if (!DEFINITIONS.has(file)) found[file] = n;
    const expected = Object.fromEntries(
      Object.entries(SAVE_SITES).map(([file, { count }]) => [file, count])
    );
    expect(found).toEqual(expected);
  });

  it('a site writing back a fresh read registers it with carryReadOutputs', () => {
    const written = Object.entries(SAVE_SITES).filter(([, s]) => s.outputs === 'written-back-read');
    expect(written.length).toBeGreaterThanOrEqual(1);
    for (const [file] of written) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(/\bcarryReadOutputs\(/);
    }
  });

  // The mechanism the fence relies on, on the persist writer itself.
  const TOKEN = '{{resolve:secretsmanager:s:SecretString:k::}}';
  const engineStub = (): DeployEngine =>
    ({
      provenanceBaseline: undefined,
      outputsRun: {
        outputProvenanceSinks: new Map(),
        outputsResolvedThisRun: new WeakSet(),
        resolvedOutputsBag: undefined,
      },
    }) as unknown as DeployEngine;

  it("a registered read's bag carries its outputReferenceProvenance whole", () => {
    const read = {
      outputs: { QueueArn: `arn:aws:sqs:us-east-1:1:${TOKEN}` },
      outputReferenceProvenance: { QueueArn: { [TOKEN]: { versions: ['v2'] } } },
    };
    carryReadOutputs(read);
    expect(
      outputReferenceProvenanceFor.call(engineStub(), read.outputs, { ...read.outputs })
    ).toEqual(read.outputReferenceProvenance);
  });

  it('an unregistered bag (a merge) still persists none', () => {
    const outputs = { QueueArn: `arn:aws:sqs:us-east-1:1:${TOKEN}` };
    expect(outputReferenceProvenanceFor.call(engineStub(), outputs, { ...outputs })).toBe(
      undefined
    );
  });

  it('a registered read without the field persists none', () => {
    const read = { outputs: { QueueArn: `arn:aws:sqs:us-east-1:1:${TOKEN}` } };
    carryReadOutputs(read);
    expect(outputReferenceProvenanceFor.call(engineStub(), read.outputs, { ...read.outputs })).toBe(
      undefined
    );
  });
});
