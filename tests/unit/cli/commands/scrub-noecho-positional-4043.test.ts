/**
 * `cdkd scrub` migrates a NoEcho-fed position without a deploy
 * (go-to-k/cdkd#4043, Phase C, design section 4.6): the POSITIONAL arm writes
 * `***` and `noEchoLeaves` wherever today's template reads a `NoEcho`
 * parameter, whatever the value's type or length, and the MIGRATION rule makes
 * the plaintext the record still holds there (a stack deployed before v11, or
 * under an older `Default`) a needle of that record, so its copies in
 * `observedProperties` and `attributes` are masked too. Through `scrubStack`
 * and the REAL resolver, which records the `NoEcho` value itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState, ResourceState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

vi.mock('../../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const SSM = 'AWS::SSM::Parameter';

function stackInfo(defaultValue: unknown, type = 'String'): {
  stackName: string;
  template: CloudFormationTemplate;
} {
  return {
    stackName: 'NoEchoScrubStack',
    template: {
      Parameters: {
        Token: { Type: type, NoEcho: true, Default: defaultValue },
      },
      Resources: {
        Param: {
          Type: SSM,
          Properties: { Name: '/app/p', Type: 'String', Value: { Ref: 'Token' } },
        },
      },
    } as unknown as CloudFormationTemplate,
  };
}

/** The record as a pre-v11 deploy wrote it: the value in the clear everywhere. */
function legacyState(stored: unknown, observedExtra: Record<string, unknown> = {}): StackState {
  const record: ResourceState = {
    physicalId: '/app/p',
    resourceType: SSM,
    properties: { Name: '/app/p', Type: 'String', Value: stored },
    observedProperties: { Name: '/app/p', Type: 'String', Value: stored, ...observedExtra },
    attributes: { Value: stored, Type: 'String' },
  };
  return {
    version: 10 as never,
    region: 'us-east-1',
    stackName: 'NoEchoScrubStack',
    resources: { Param: record },
    outputs: {},
    lastModified: 0,
  };
}

describe('cdkd scrub - the NoEcho positional arm and migration rule (go-to-k/cdkd#4043 Phase C)', () => {
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-2'),
      purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn().mockResolvedValue([]),
    };
  });

  async function scrub(
    state: StackState,
    info: ReturnType<typeof stackInfo>,
    dryRun = false
  ): Promise<{ saved: StackState | undefined; changed: number }> {
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-1' });
    const res = await scrubStack(info as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun,
      logger: logger as never,
    });
    const call = stateBackend['saveState']!.mock.calls.at(-1);
    return { saved: call ? (call[2] as StackState) : undefined, changed: res.recordsChanged };
  }

  it.each([
    ['a long value', 'cdkd-scrub-noecho-4043-value', 'String'],
    ['a 3-character value', 'q7z', 'String'],
    ['a number', 4242, 'Number'],
  ])('%s: *** at the position, in the observed baseline and the echoing attribute', async (_l, value, type) => {
    const { saved, changed } = await scrub(legacyState(value), stackInfo(value, type));

    expect(changed).toBeGreaterThan(0);
    const record = saved!.resources['Param']!;
    expect(record.properties).toEqual({ Name: '/app/p', Type: 'String', Value: '***' });
    expect(record.noEchoLeaves).toEqual([['Value']]);
    expect(record.observedProperties?.['Value']).toBe('***');
    expect(record.attributes).toEqual({ Value: '***', Type: 'String' });
    expect(record.noEchoAttributeNames).toEqual(['Value']);
    expect(JSON.stringify(saved)).not.toContain(`:${JSON.stringify(value)}`);
  });

  it('a stack deployed under an OLDER Default: the stored value is the needle, even embedded elsewhere', async () => {
    const stored = 'old-noecho-default-4043';
    const { saved } = await scrub(
      legacyState(stored, { Description: `rotated from ${stored} last week` }),
      stackInfo('new-noecho-default-4043')
    );

    const record = saved!.resources['Param']!;
    expect(record.properties['Value']).toBe('***');
    expect(record.observedProperties?.['Value']).toBe('***');
    // The containment arm flattens a leaf that EMBEDS the stored value.
    expect(record.observedProperties?.['Description']).toBe('***');
    expect(JSON.stringify(saved)).not.toContain(stored);
    // An unrelated leaf of the record is untouched by the needle.
    expect(record.properties['Name']).toBe('/app/p');
  });

  it('--dry-run counts the record as a finding and writes nothing', async () => {
    const { saved, changed } = await scrub(legacyState('q7z'), stackInfo('q7z'), true);
    expect(changed).toBeGreaterThan(0);
    expect(saved).toBeUndefined();
  });

  it('an already-migrated record is not a finding', async () => {
    const state = legacyState('***');
    state.resources['Param']!.noEchoLeaves = [['Value']];
    state.resources['Param']!.attributes = { Value: '***', Type: 'String' };
    state.resources['Param']!.noEchoAttributeNames = ['Value'];
    const { changed } = await scrub(state, stackInfo('q7z'), true);
    expect(changed).toBe(0);
  });

  // Design section 5's Phase C residual: an alias the deploy now REFUSES (its
  // Export.Name reads a NoEcho parameter) is a declared name whose key the
  // record lacks by design, so it no longer makes every unnamed key a
  // possible live alias.
  async function aliasScrub(
    outputs: Record<string, unknown>,
    exportNames: string[] | undefined,
    exportName: unknown = { Ref: 'Token' }
  ) {
    const info = stackInfo(ALIAS_TOKEN);
    info.template.Conditions = { Always: { 'Fn::Equals': ['a', 'a'] } } as never;
    (info.template as unknown as { Outputs: unknown }).Outputs = {
      Probe: { Value: 'probe-value', Export: { Name: exportName } },
    };
    const state = legacyState('***');
    state.resources['Param']!.noEchoLeaves = [['Value']];
    state.resources['Param']!.attributes = { Value: '***', Type: 'String' };
    state.resources['Param']!.noEchoAttributeNames = ['Value'];
    state.outputs = outputs;
    if (exportNames === undefined) delete state.exportNames;
    else state.exportNames = exportNames;
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-1' });
    return scrubStack(info as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: true,
      logger: logger as never,
    });
  }
  const ALIAS_TOKEN = 'cdkd-scrub-alias-token-4043';

  it('a LITERAL Export.Name spelling the NoEcho value (the seed arm) is refused the same way', async () => {
    const res = await aliasScrub({ Probe: 'probe-value', Unnamed: 'x' }, undefined, `pre-${ALIAS_TOKEN}`);
    expect(res.keptAliasOutputKeys).toBe(0);
    expect(res.droppedOutputKeys).toBe(1);
  });

  it('a refused NoEcho alias the record lacks does not keep an unnamed key as a possible alias', async () => {
    // A record with no `exportNames` (every key may be an export): `Unnamed`
    // could be a live alias, which only a fully reproduced alias set rules out.
    const res = await aliasScrub({ Probe: 'probe-value', Unnamed: 'x' }, undefined);
    expect(res.keptAliasOutputKeys).toBe(0);
    expect(res.droppedOutputKeys).toBe(1);
  });

  it('the alias key an older binary published under the NoEcho value is reported, never printed', async () => {
    const res = await aliasScrub({ Probe: 'probe-value', [ALIAS_TOKEN]: 'probe-value' }, [ALIAS_TOKEN]);
    expect(res.secretBearingKeys).toBe(1);
    expect(
      logger.warn.mock.calls.some((c) => String(c[0]).includes('holds an output KEY that renders a secret'))
    ).toBe(true);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(ALIAS_TOKEN);
  });

  // Review round 1 (#4764), security M1: a declared output a NoEcho parameter
  // serves, and an alias key holding the same stored value, are masked as the
  // deploy's `maskOutputsByPosition` writes them -- even with no resource
  // reading the parameter and no `Default` to bind.
  it('masks a NoEcho-served output and its alias key, on a stack with no other finding', async () => {
    const info = stackInfo('unused');
    const tpl = info.template as unknown as {
      Parameters: Record<string, Record<string, unknown>>;
      Resources: Record<string, unknown>;
      Outputs: unknown;
    };
    delete tpl.Parameters['Token']!['Default'];
    tpl.Resources = {};
    tpl.Outputs = { Conn: { Value: { Ref: 'Token' }, Export: { Name: 'conn-export' } } };
    const state = legacyState('x');
    state.resources = {};
    state.outputs = { Conn: 'q7z', 'conn-export': 'q7z' };
    state.exportNames = ['conn-export'];
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-1' });
    const res = await scrubStack(info as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger: logger as never,
    });
    expect(res.recordsChanged).toBeGreaterThan(0);
    const saved = stateBackend['saveState']!.mock.calls.at(-1)![2] as StackState;
    expect({ ...saved.outputs }).toEqual({ Conn: '***', 'conn-export': '***' });
  });

  it('an Fn::If Export.Name reading a NoEcho parameter in one branch stays a possible live alias', async () => {
    const res = await aliasScrub({ Probe: 'probe-value', Unnamed: 'x' }, undefined, {
      'Fn::If': ['NeverTrue', { Ref: 'Token' }, 'public-export-name'],
    });
    expect(res.keptAliasOutputKeys).toBe(1);
  });

  it('R6: an Fn::If Export.Name spelling the NoEcho value literally in one branch stays a possible live alias', async () => {
    const res = await aliasScrub({ Probe: 'probe-value', Unnamed: 'x' }, undefined, {
      // The SELECTED branch spells it, so only the Fn::If exclusion keeps it.
      'Fn::If': ['Always', `pre-${ALIAS_TOKEN}`, 'public-export-name'],
    });
    expect(res.keptAliasOutputKeys).toBe(1);
  });

  it('a marked coordinate holding a whole {{resolve:...}} token is kept and is no finding', async () => {
    const token = '{{resolve:secretsmanager:app/pw:SecretString:pw}}';
    const state = legacyState('x');
    const record = state.resources['Param']!;
    record.properties = { Name: '/app/p', Type: 'String', Value: token, Description: '***' };
    record.noEchoLeaves = [['Description'], ['Value']];
    record.observedProperties = { Name: '/app/p', Type: 'String', Value: '***', Description: '***' };
    record.attributes = { Type: 'String' };
    const info = stackInfo('q7z');
    // Today's template positions Description only; Value's coordinate came
    // from a source scrub cannot see (a parent row's reference, say).
    info.template.Resources['Param']!.Properties = {
      Name: '/app/p',
      Type: 'String',
      // Not the reference itself, which scrub would resolve against AWS.
      Value: 'from-a-parent-row',
      Description: { Ref: 'Token' },
    };
    const { changed } = await scrub(state, info, true);
    expect(changed).toBe(0);
  });

  it('a dropped stale key does not undo the NoEcho output mask; a declared output of the same value is kept', async () => {
    const info = stackInfo('unused');
    const tpl = info.template as unknown as {
      Parameters: Record<string, Record<string, unknown>>;
      Resources: Record<string, unknown>;
      Outputs: unknown;
    };
    delete tpl.Parameters['Token']!['Default'];
    tpl.Resources = {};
    tpl.Outputs = {
      DbPort: { Value: { Ref: 'Token' } },
      ReplicaPort: { Value: '5432' },
    };
    const state = legacyState('x');
    state.resources = {};
    state.outputs = { DbPort: '5432', ReplicaPort: '5432', Stale: 'from-a-deleted-output' };
    delete state.exportNames;
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-1' });
    const res = await scrubStack(info as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: false,
      logger: logger as never,
    });
    expect(res.droppedOutputKeys).toBe(1);
    const saved = stateBackend['saveState']!.mock.calls.at(-1)![2] as StackState;
    expect({ ...saved.outputs }).toEqual({ DbPort: '***', ReplicaPort: '5432' });
  });

  // Review round 4 (#4764).
  it('G3: the migration needle is THIS record\'s: another record holding the same literal is untouched', async () => {
    const stored = 'shared-literal-noecho-4043';
    const state = legacyState(stored);
    state.resources['Other'] = {
      physicalId: '/app/o',
      resourceType: SSM,
      properties: { Name: '/app/o', Type: 'String', Value: stored },
      attributes: { Value: stored },
    };
    const info = stackInfo('new-default-4043');
    info.template.Resources['Other'] = {
      Type: SSM,
      Properties: { Name: '/app/o', Type: 'String', Value: stored },
    } as never;
    const { saved } = await scrub(state, info);
    expect(saved!.resources['Param']!.properties['Value']).toBe('***');
    expect(saved!.resources['Other']).toEqual(state.resources['Other']);
  });

  it("G4: a record's own noEchoLeaves is authoritative: a coordinate today's template no longer feeds is still masked, and counted", async () => {
    const state = legacyState('q7z');
    state.resources['Param']!.noEchoLeaves = [['Value']];
    const info = stackInfo('q7z');
    (info.template.Resources['Param']!.Properties as Record<string, unknown>)['Value'] = 'literal';
    const { saved, changed } = await scrub(state, info);
    expect(changed).toBeGreaterThan(0);
    expect(saved!.resources['Param']!.properties['Value']).toBe('***');
    expect(saved!.resources['Param']!.noEchoLeaves).toEqual([['Value']]);
  });

  it("R5a: an attribute the record's own noEchoAttributeNames declares is masked whole, and counted", async () => {
    const state = legacyState('***');
    const record = state.resources['Param']!;
    record.noEchoLeaves = [['Value']];
    record.attributes = { Value: '***', Type: 'String', Extra: 'plain-declared-attr' };
    record.noEchoAttributeNames = ['Extra', 'Value'];
    const { saved, changed } = await scrub(state, stackInfo('q7z'));
    expect(changed).toBeGreaterThan(0);
    expect(saved!.resources['Param']!.attributes).toEqual({
      Value: '***',
      Type: 'String',
      Extra: '***',
    });
    expect(saved!.resources['Param']!.noEchoAttributeNames).toEqual(['Extra', 'Value']);
  });

  it.each([
    ['keeps an entry the record still marks', [['Value'], ['Gone']], [['Value']]],
    ['drops the field when no entry is still marked', [['Gone']], undefined],
  ])('R5b: noEchoExactEchoLeaves %s', async (_l, exact, expected) => {
    const state = legacyState('q7z');
    state.resources['Param']!.noEchoExactEchoLeaves = exact;
    const { saved } = await scrub(state, stackInfo('q7z'));
    expect(saved!.resources['Param']!.noEchoExactEchoLeaves).toEqual(expected);
  });

  it("R5c: a record's own noEchoLeaves REPLACES the template's positions, never unions with them", async () => {
    const state = legacyState('q7z');
    const record = state.resources['Param']!;
    record.noEchoLeaves = [['Value']];
    record.properties = { ...record.properties, Description: 'other-description' };
    const info = stackInfo('q7z');
    (info.template.Resources['Param']!.Properties as Record<string, unknown>)['Description'] = {
      Ref: 'Token',
    };
    const { saved } = await scrub(state, info);
    expect(saved!.resources['Param']!.noEchoLeaves).toEqual([['Value']]);
    expect(saved!.resources['Param']!.properties['Description']).toBe('other-description');
    expect(saved!.resources['Param']!.properties['Value']).toBe('***');
  });

  it.each([
    ['its type changed in the template', (info: ReturnType<typeof stackInfo>) => {
      info.template.Resources['Param']!.Type = 'AWS::SNS::Topic';
    }],
    ['the template no longer declares it', (info: ReturnType<typeof stackInfo>) => {
      delete info.template.Resources['Param'];
    }],
  ])('G9: a record whose %s is not positioned', async (_l, edit) => {
    const info = stackInfo('q7z');
    edit(info);
    const { changed } = await scrub(legacyState('q7z'), info, true);
    expect(changed).toBe(0);
  });

  // A value under the needle floor, so only the positional arm (by name) and
  // the by-value alias arm can mask it: the by-value arm must not reach
  // another declared output's alias.
  it("m2: another output's alias holding the same short value is not masked; the served output's own alias is", async () => {
    const info = stackInfo('yes');
    const tpl = info.template as unknown as { Resources: Record<string, unknown>; Outputs: unknown };
    tpl.Resources = {};
    tpl.Outputs = {
      Enabled: { Value: 'yes', Export: { Name: 'MyStack-Enabled' } },
      Served: { Value: { Ref: 'Token' }, Export: { Name: 'served-alias' } },
    };
    const state = legacyState('x');
    state.resources = {};
    state.outputs = {
      Enabled: 'yes',
      'MyStack-Enabled': 'yes',
      Served: 'yes',
      'served-alias': 'yes',
    };
    state.exportNames = ['MyStack-Enabled', 'served-alias'];
    const { saved } = await scrub(state, info);
    expect({ ...saved!.outputs }).toEqual({
      Enabled: 'yes',
      'MyStack-Enabled': 'yes',
      Served: '***',
      'served-alias': '***',
    });
  });

  // R3: the OWN-alias arm alone. The alias holds an older value, so the
  // by-value arm cannot reach it.
  it("the served output's own alias is masked by name even when it holds an older value", async () => {
    const info = stackInfo('yes');
    const tpl = info.template as unknown as { Resources: Record<string, unknown>; Outputs: unknown };
    tpl.Resources = {};
    tpl.Outputs = { Served: { Value: { Ref: 'Token' }, Export: { Name: 'served-alias' } } };
    const state = legacyState('x');
    state.resources = {};
    state.outputs = { Served: 'yes', 'served-alias': 'old-default' };
    state.exportNames = ['served-alias'];
    const { saved } = await scrub(state, info);
    expect({ ...saved!.outputs }).toEqual({ Served: '***', 'served-alias': '***' });
  });

  it('m4: a Fn::GetAtt consumer of an echoing producer is positioned whatever the record order', async () => {
    const state = legacyState('q7z');
    // The consumer first: its position depends on the producer's echo.
    const consumer = {
      physicalId: '/app/c',
      resourceType: SSM,
      properties: { Name: '/app/c', Type: 'String', Value: 'q7z' },
      attributes: {},
    };
    state.resources = { Consumer: consumer, ...state.resources };
    const info = stackInfo('q7z');
    info.template.Resources = {
      Consumer: {
        Type: SSM,
        Properties: { Name: '/app/c', Type: 'String', Value: { 'Fn::GetAtt': ['Param', 'Value'] } },
      },
      ...info.template.Resources,
    } as never;
    const { saved } = await scrub(state, info);
    expect(saved!.resources['Consumer']!.properties['Value']).toBe('***');
    expect(saved!.resources['Consumer']!.noEchoLeaves).toEqual([['Value']]);
  });

  it("decision 8: a nested child's parameter its parent's row fills from a NoEcho source is positioned", async () => {
    const childTemplate = {
      Parameters: { ListIn: { Type: 'String' } },
      Resources: {
        Param: { Type: SSM, Properties: { Name: '/app/p', Type: 'String', Value: { Ref: 'ListIn' } } },
      },
    } as unknown as CloudFormationTemplate;
    stateBackend['getState']!.mockResolvedValue({ state: legacyState('q7z'), etag: 'etag-1' });
    const res = await scrubStack(
      { stackName: 'NoEchoScrubStack~Child', template: childTemplate } as never,
      'us-east-1',
      stateBackend as never,
      lockManager as never,
      {
        dryRun: false,
        logger: logger as never,
        nestedChild: {
          logicalId: 'Child',
          stackName: 'NoEchoScrubStack~Child',
          input: { parameters: { ListIn: 'q7z' }, inheritedSecrets: new Map(), noEchoParameters: ['ListIn'] },
        },
      } as never
    );
    expect(res.recordsChanged).toBeGreaterThan(0);
    const saved = stateBackend['saveState']!.mock.calls.at(-1)![2] as StackState;
    expect(saved.resources['Param']!.properties['Value']).toBe('***');
    expect(saved.resources['Param']!.noEchoLeaves).toEqual([['Value']]);
  });

  // Round 4 (#4764), R4 / security M2: the PARENT side of decision 8. A row
  // parameter fed by an echoed NoEcho attribute counts once the plan's fixed
  // point declared it; a plaintext or an Fn::If row parameter does not.
  it("decision 8, parent side: the nested child's NoEcho-filled parameters, read off the row", async () => {
    const info = stackInfo('q7z');
    info.template.Conditions = { Always: { 'Fn::Equals': ['a', 'a'] } } as never;
    info.template.Resources['Child'] = {
      Type: 'AWS::CloudFormation::Stack',
      Properties: {
        TemplateURL: 'https://example.com/child.json',
        Parameters: {
          ListIn: { Ref: 'Token' },
          FromAttr: { 'Fn::GetAtt': ['Param', 'Value'] },
          Plain: 'plain-row-value',
          Chosen: { 'Fn::If': ['Always', { Ref: 'Token' }, 'other'] },
        },
      },
    } as never;
    const state = legacyState('q7z');
    state.resources['Child'] = {
      physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/child/1',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {},
      attributes: {},
    };
    stateBackend['getState']!.mockResolvedValue({ state, etag: 'etag-1' });
    const res = await scrubStack(info as never, 'us-east-1', stateBackend as never, lockManager as never, {
      dryRun: true,
      logger: logger as never,
    });
    const child = res.nestedChildren.find((c) => c.logicalId === 'Child');
    expect(child?.input?.noEchoParameters).toEqual(['ListIn', 'FromAttr']);
  });

  it('G9: an attribute equal to the physical id is not taken as an echo', async () => {
    const state = legacyState('q7z');
    state.resources['Param']!.physicalId = 'q7z';
    const { saved } = await scrub(state, stackInfo('q7z'));
    expect(saved!.resources['Param']!.properties['Value']).toBe('***');
    expect(saved!.resources['Param']!.attributes).toEqual({ Value: 'q7z', Type: 'String' });
  });
});
