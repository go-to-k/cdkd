import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// go-to-k/cdkd#7070: an invariant over EVERY spec-replacement candidate with a
// measured verdict, driven through the real diff and the real create-only
// resolver. DescribeType answers each type with its committed registry
// snapshot, so the only thing that can add a replacement is the generated
// table: a `replace` row must replace (or its hand rule decides), and an
// `update` row must stay in place.

const SNAPSHOT = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/cfn-registry-create-only-paths.json'), 'utf8')
) as { types: Record<string, string[][]> };

const mockSend = vi.fn(async (command: { input?: { TypeName?: string } }) => {
  const type = command.input?.TypeName ?? '';
  const paths = SNAPSHOT.types[type] ?? [];
  return {
    Schema: JSON.stringify({ createOnlyProperties: paths.map((p) => `/properties/${p.join('/')}`) }),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ cloudFormation: { send: mockSend } }),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const quiet = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...quiet, child: () => quiet }) };
});

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { REPLACEMENT_EVIDENCE } from '../../../src/analyzer/replacement-rules/evidence.js';
import { SPEC_REPLACEMENT_PATHS } from '../../../src/analyzer/replacement-rules/spec-replacement-properties.generated.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import type { StackState } from '../../../src/types/state.js';
import {
  candidateKey,
  loadSpecReplacementCandidates,
} from '../../../scripts/spec-replacement-candidates.ts';

/** A property bag holding `leaf` at `path`. */
function bagAt(path: readonly string[], leaf: string): Record<string, unknown> {
  let value: unknown = leaf;
  for (const segment of [...path].reverse()) value = { [segment]: value };
  return value as Record<string, unknown>;
}

/** Whether changing only the value at `path` makes the diff replace the resource. */
async function replacesOnChange(type: string, path: readonly string[]): Promise<boolean> {
  const state: StackState = {
    version: 1,
    stackName: 'S',
    resources: {
      R: { physicalId: 'p', resourceType: type, properties: bagAt(path, 'old'), attributes: {} },
    },
    outputs: {},
    lastModified: 0,
  };
  const template = { Resources: { R: { Type: type, Properties: bagAt(path, 'new') } } };
  const changes = await new DiffCalculator().calculateDiff(state, template);
  const change = changes.get('R')?.propertyChanges?.find((c) => c.path === path[0]);
  expect(change, candidateKey(type, path)).toBeDefined();
  return change!.requiresReplacement;
}

describe('spec-replacement table (go-to-k/cdkd#7070)', () => {
  const registry = new ReplacementRulesRegistry();
  const { candidates } = loadSpecReplacementCandidates();
  const measured = candidates.filter((c) => {
    const verdict = REPLACEMENT_EVIDENCE.get(candidateKey(c.type, c.path))?.verdict;
    return verdict === 'replace' || verdict === 'update';
  });

  beforeEach(() => {
    clearCreateOnlyPropertiesCache();
  });

  it('the table is exactly the candidates measured as replacing', () => {
    const rows = [...SPEC_REPLACEMENT_PATHS].flatMap(([type, paths]) =>
      paths.map((p) => candidateKey(type, p))
    );
    // A hand rule decides its own candidates, so they stay out of the table
    // (readers that consult no hand rule would otherwise see them).
    const replacing = measured
      .filter((c) => REPLACEMENT_EVIDENCE.get(candidateKey(c.type, c.path))!.verdict === 'replace')
      .filter((c) => !registry.isClassified(c.type, c.path[0]!))
      .map((c) => candidateKey(c.type, c.path));
    expect(rows.sort()).toEqual(replacing.sort());
    // Floors: the #7070 seeds, so an empty table or population cannot pass.
    expect(rows).toEqual(
      expect.arrayContaining([
        'AWS::Route53Resolver::ResolverRule#DomainName',
      ])
    );
    expect(measured.length).toBeGreaterThanOrEqual(30);
  });

  it('no table row is one a hand rule decides', () => {
    const handDecided = [...SPEC_REPLACEMENT_PATHS]
      .flatMap(([type, paths]) => paths.map((p) => [type, p] as const))
      .filter(([type, p]) => registry.isClassified(type, p[0]!))
      .map(([type, p]) => candidateKey(type, p));
    expect(handDecided).toEqual([]);
  });

  it('every measured candidate gets its verdict from the diff', async () => {
    const wrong: string[] = [];
    for (const c of measured) {
      const key = candidateKey(c.type, c.path);
      const top = c.path[0]!;
      const expected = registry.isClassified(c.type, top)
        ? registry.requiresReplacement(c.type, top, bagAt(c.path, 'old')[top], bagAt(c.path, 'new')[top])
        : REPLACEMENT_EVIDENCE.get(key)!.verdict === 'replace';
      if ((await replacesOnChange(c.type, c.path)) !== expected) wrong.push(key);
    }
    expect(wrong).toEqual([]);
  });

  // The rename CloudFormation fails rather than replaces stays the provider's
  // refusal (#3750), not a replacement of a stateful database.
  it('a nested measured update stays in place', async () => {
    expect(await replacesOnChange('AWS::Glue::Database', ['DatabaseInput', 'Name'])).toBe(false);
  });
});
