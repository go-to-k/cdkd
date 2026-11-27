import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vite-plus/test';
import {
  OUT_JSON,
  OUT_MD,
  asyncEvidence,
  buildPopulation,
  checkClassification,
  isTransitionalValue,
  renderJson,
  renderMarkdown,
  type PopulationRow,
} from '../../../scripts/gen-async-operation-waits.ts';
import { ASYNC_OPERATION_CLASSIFICATION } from '../../../src/provisioning/async-operation-waits.js';

/**
 * go-to-k/cdkd#7132: every provider call the SDK model marks asynchronous has a
 * verdict on whether the provider waits for it, and a `waits` verdict names a
 * helper the provider still references.
 */

const population = buildPopulation();

describe('the committed classification (#7132)', () => {
  it('classifies every asynchronous operation, with no stale row and no lost helper', () => {
    expect(checkClassification(population)).toEqual({
      unclassified: [],
      stale: [],
      missingHelper: [],
    });
  });

  it('keeps the generated files current', () => {
    expect(readFileSync(OUT_JSON, 'utf8')).toBe(renderJson(population));
    expect(readFileSync(OUT_MD, 'utf8')).toBe(renderMarkdown(population));
  });

  it('gives every unmeasured and no-wait row a reason, and every waits row a helper', () => {
    for (const [key, v] of Object.entries(ASYNC_OPERATION_CLASSIFICATION)) {
      if (v.verdict === 'waits') {
        expect(v.helpers.length, key).toBeGreaterThan(0);
        for (const h of v.helpers) expect(h, key).toMatch(/^[A-Za-z_$][\w$]*$/);
      }
      else expect(v.reason.trim(), key).not.toBe('');
    }
  });
});

describe('the population rules', () => {
  const keys = new Set(population.map((r) => r.key));

  it('finds the three instances found by hand, each by its own signal', () => {
    // #7127: a Start* operation whose output status enum carries PROCESSING.
    expect(asyncEvidence('appsync', 'StartSchemaCreation').map((e) => e.signal)).toEqual([
      'start-operation',
      'transitional-enum',
    ]);
    // #6778: a toggle whose output enum carries ENABLING.
    expect(asyncEvidence('dynamodb', 'UpdateContributorInsights')).toEqual([
      {
        signal: 'transitional-enum',
        detail: 'ContributorInsightsStatus: ContributorInsightsStatus (DISABLING, ENABLING)',
      },
    ]);
    // #5737: the SDK models the mapping's State as a plain string.
    expect(asyncEvidence('lambda', 'CreateEventSourceMapping')).toEqual([
      { signal: 'state-string', detail: 'State: string' },
    ]);
    for (const k of [
      'appsync:StartSchemaCreation',
      'dynamodb:UpdateContributorInsights',
      'lambda:CreateEventSourceMapping',
    ]) {
      expect(keys.has(k), k).toBe(true);
    }
  });

  it('leaves read operations out: they start nothing', () => {
    expect([...keys].filter((k) => /:(Describe|Get|List)[A-Z]/.test(k))).toEqual([]);
  });

  it('reads a transitional value case- and separator-insensitively, and not a steady -ING word', () => {
    for (const v of [
      'CREATING',
      'Creating',
      'pending',
      'PENDING_ACCEPTANCE',
      'IN_PROGRESS',
      'InProgress',
      'CREATE_IN_PROGRESS',
      'PROCESSING',
    ]) {
      expect(isTransitionalValue(v), v).toBe(true);
    }
    for (const v of [
      'ACTIVE',
      'STRING',
      'SINGLE_STRING',
      'Throttling',
      'INTELLIGENT_TIERING',
      'internet-facing',
      'RUNNING',
      'FAILED',
    ]) {
      expect(isTransitionalValue(v), v).toBe(false);
    }
  });
});

describe('the critic', () => {
  const row = (key: string, unit: string): PopulationRow => {
    const [client, operation] = key.split(':') as [string, string];
    return { key, client, operation, evidence: [], files: [unit], units: [unit] };
  };
  const unit = 'src/provisioning/providers/dynamodb-table-provider.ts';

  it('fails an unclassified operation and a row no provider sends', () => {
    expect(
      checkClassification([row('x:StartThing', unit)], {
        'x:Gone': { verdict: 'unmeasured', reason: 'r' },
      })
    ).toEqual({ unclassified: ['x:StartThing'], stale: ['x:Gone'], missingHelper: [] });
  });

  it('fails a waits row whose helper the provider unit no longer references', () => {
    const findings = checkClassification([row('x:StartThing', unit)], {
      'x:StartThing': { verdict: 'waits', helpers: ['noSuchWaitHelperAnywhere'], failureStatuses: [] },
    });
    expect(findings.missingHelper).toEqual([
      `x:StartThing: ${unit} references none of noSuchWaitHelperAnywhere`,
      'x:StartThing: no sending provider references noSuchWaitHelperAnywhere',
    ]);
  });

  it('fails a waits row listing a helper no sending unit references, beside one that is', () => {
    const findings = checkClassification([row('x:StartThing', unit)], {
      'x:StartThing': {
        verdict: 'waits',
        helpers: ['applyIndexUpdates', 'noSuchWaitHelperAnywhere'],
        failureStatuses: [],
      },
    });
    expect(findings.missingHelper).toEqual([
      'x:StartThing: no sending provider references noSuchWaitHelperAnywhere',
    ]);
  });

  it('accepts a helper referenced only from a companion file of the unit', () => {
    const findings = checkClassification([row('x:StartThing', unit)], {
      // Defined and called in providers/dynamodb-table/** only, never named in the root file.
      'x:StartThing': {
        verdict: 'waits',
        helpers: ['applyIndexUpdates'],
        failureStatuses: [],
      },
    });
    expect(findings.missingHelper).toEqual([]);
  });
});
