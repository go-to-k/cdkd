/**
 * go-to-k/cdkd#7194: the deploy's save records an EMPTY `noEchoLeaves` on a
 * record it positioned and found no `NoEcho` position in, so `cdkd scrub` can
 * tell it from a record written before v11 (no field). An empty field reads
 * as absent everywhere else: a save positions it by today's template again.
 */
import { describe, it, expect } from 'vite-plus/test';
import { applyNoEchoPersist, NoEchoRunState } from '../../../src/deployment/deploy-engine/noecho.js';
import type { ResourceState } from '../../../src/types/state.js';

const TYPE = 'AWS::Test::Thing7194';

function runWithTemplate(): NoEchoRunState {
  const run = new NoEchoRunState();
  run.constructPathTemplate = {
    Parameters: { Pw: { Type: 'String', NoEcho: true } },
    Resources: {
      Plain: { Type: TYPE, Properties: { Name: 'public-name' } },
      Secret: { Type: TYPE, Properties: { Password: { Ref: 'Pw' }, Name: 'n' } },
    },
  } as never;
  return run;
}

const deps = {
  perResourceSecrets: () => new Map(),
  perResourceResolvedType: () => new Map(),
} as never;

/** The live record's save (`markEmpty`), or a carried record's (`live: false`). */
function persist(
  run: NoEchoRunState,
  logicalId: string,
  record: ResourceState,
  { live = true, templateProps }: { live?: boolean; templateProps?: Record<string, unknown> } = {}
): ResourceState {
  return applyNoEchoPersist(
    run,
    deps,
    logicalId,
    record,
    record,
    templateProps,
    { [logicalId]: record },
    undefined,
    false,
    live
  );
}

describe('noEchoLeaves empty marker (go-to-k/cdkd#7194)', () => {
  it('a positioned record with no NoEcho position is saved with noEchoLeaves: []', () => {
    const record: ResourceState = {
      physicalId: 'p1',
      resourceType: TYPE,
      properties: { Name: 'public-name' },
    };
    const out = persist(runWithTemplate(), 'Plain', record);
    expect(out.noEchoLeaves).toEqual([]);
    expect(out.properties).toEqual({ Name: 'public-name' });
  });

  it('an empty field is positioned by today template again, as an absent one is', () => {
    const record: ResourceState = {
      physicalId: 'p2',
      resourceType: TYPE,
      properties: { Password: 'pw-plain-7194', Name: 'n' },
      noEchoLeaves: [],
    };
    const out = persist(runWithTemplate(), 'Secret', record);
    expect(out.noEchoLeaves).toEqual([['Password']]);
    expect(out.properties).toEqual({ Password: '***', Name: 'n' });
    expect(JSON.stringify(out)).not.toContain('pw-plain-7194');
  });

  it('a carried record gains no marker: its bag is of another template generation', () => {
    const run = runWithTemplate();
    const row: ResourceState = { physicalId: 'p5', resourceType: TYPE, properties: { Name: 'x' } };
    expect(Object.hasOwn(persist(run, 'Plain', row, { live: false }), 'noEchoLeaves')).toBe(false);
    // One it already had is kept.
    const marked = { ...row, noEchoLeaves: [] };
    expect(persist(run, 'Plain', marked, { live: false }).noEchoLeaves).toEqual([]);
  });

  it('a live record whose bag this deploy did not write (a failed update) gains no marker', () => {
    const record: ResourceState = { physicalId: 'p6', resourceType: TYPE, properties: { Name: 'old' } };
    const out = persist(runWithTemplate(), 'Plain', record, {
      templateProps: { Name: 'public-name' },
    });
    expect(Object.hasOwn(out, 'noEchoLeaves')).toBe(false);
  });

  it('a record of a logical id the template no longer declares keeps what it had', () => {
    const run = runWithTemplate();
    const marked: ResourceState = {
      physicalId: 'p3',
      resourceType: TYPE,
      properties: { Name: 'x' },
      noEchoLeaves: [],
    };
    expect(persist(run, 'Gone', marked).noEchoLeaves).toEqual([]);
    const unmarked: ResourceState = { physicalId: 'p4', resourceType: TYPE, properties: {} };
    expect(Object.hasOwn(persist(run, 'Gone', unmarked), 'noEchoLeaves')).toBe(false);
  });
});
