import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/**
 * A redeploy of an UNCHANGED template whose property is `Fn::Base64` over a
 * `{{resolve:...}}` input sends nothing (go-to-k/cdkd#3662 review round).
 *
 * `Fn::Base64` registers the encoding of a secret as a MASK-ONLY needle
 * (issue #2759), so the record persists `***`. The diff, which does not
 * resolve dynamic references, compares a WHOLE-leaf encoding as that mask
 * (issue #2909), so it reports NO_CHANGE; a leaf EMBEDDING the encoding still
 * diffs UPDATE, and the engine's no-change skip absorbs that. #3662 stopped the skip trusting a
 * mask for a `NoEcho` value supplied in the same deploy; this is the other
 * mask-only population, a DERIVED needle, which must keep taking the skip, or
 * every deploy re-sends it (a new LaunchTemplate version, an Instance
 * `UserData` update). The resolver and the diff are REAL here.
 */
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi
        .fn()
        .mockResolvedValue({ Parameter: { Value: 'pw-secret-value', Type: 'SecureString' } }),
    },
  }),
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const PROPS = {
  Name: '/app/ud',
  Type: 'String',
  Value: { 'Fn::Base64': { 'Fn::Join': ['', ['pw=', '{{resolve:ssm-secure:/app/pw}}']] } },
};
// go-to-k/cdkd#2453: the same encoding EMBEDDED in a longer leaf, which a
// whole-leaf-only mask left decodable in state.
const EMBEDDED_PROPS = {
  Name: '/app/ud',
  Type: 'String',
  Value: { 'Fn::Join': ['', ['#!/bin/bash\nUD=', PROPS.Value, '\n']] },
};
const encoded = Buffer.from('pw=pw-secret-value').toString('base64');

describe('DeployEngine - a Base64-encoded secret is not re-sent on an unchanged redeploy', () => {
  it('persists the mask on CREATE, and the redeploy diffs NO_CHANGE (go-to-k/cdkd#2909)', async () => {
    await createThenRedeploy(PROPS, 'NO_CHANGE');
  });

  it('masks WHOLE a leaf EMBEDDING the encoding, and still skips the unchanged redeploy (go-to-k/cdkd#2453)', async () => {
    const { created, provider } = await createThenRedeploy(EMBEDDED_PROPS, 'UPDATE');
    // The value AWS received really did embed the encoding...
    expect(provider.create.mock.calls[0]![2]).toMatchObject({
      Value: `#!/bin/bash\nUD=${encoded}\n`,
    });
    // ...and no state version holds it.
    expect(JSON.stringify(created)).not.toContain(encoded);
  });
});

async function createThenRedeploy(
  props: Record<string, unknown>,
  redeployChange: 'NO_CHANGE' | 'UPDATE'
): Promise<{ created: StackState; provider: { create: ReturnType<typeof vi.fn> } }> {
  const template: CloudFormationTemplate = {
    Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
  };
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: 'p' }),
    update: vi.fn().mockResolvedValue({ physicalId: 'p', wasReplaced: false }),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  const saveState = vi.fn().mockResolvedValue('etag');
  const getState = vi.fn().mockResolvedValue({ state: null, etag: undefined });
  const real = new DiffCalculator();
  const diff = {
    calculateDiff: vi.fn(),
    hasChanges: vi.fn().mockReturnValue(true),
    filterByType: vi
      .fn()
      .mockImplementation((c: Map<string, ResourceChange>, t: string) =>
        [...c.values()].filter((x) => x.changeType === t)
      ),
  };
  const makeEngine = (): DeployEngine =>
    new DeployEngine(
      {
        getState,
        saveState,
        loadRollbackJournal: vi.fn().mockResolvedValue(null),
        appendRollbackJournalSegment: vi.fn(),
        popRollbackJournalSegment: vi.fn(),
        deleteRollbackJournal: vi.fn(),
      } as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(true), releaseLock: vi.fn() } as never,
      {
        buildGraph: vi.fn().mockReturnValue({}),
        getExecutionLevels: vi.fn().mockReturnValue([['R']]),
        getDirectDependencies: vi.fn().mockReturnValue([]),
      } as never,
      diff as never,
      {
        getProvider: vi.fn().mockReturnValue(provider),
        getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
      } as never,
      { dryRun: false },
      'us-east-1'
    );

  diff.calculateDiff.mockResolvedValue(
    new Map([
      [
        'R',
        {
          logicalId: 'R',
          changeType: 'CREATE',
          resourceType: 'AWS::SSM::Parameter',
          desiredProperties: props,
        },
      ],
    ])
  );
  await makeEngine().deploy('s', template);
  const created = saveState.mock.calls.at(-1)![2] as StackState;
  expect(created.resources['R']!.properties['Value']).toBe('***');

  // The redeploy runs the REAL diff over the record the create wrote.
  getState.mockResolvedValue({ state: created, etag: 'e' });
  diff.calculateDiff.mockImplementation((...args: unknown[]) =>
    (real.calculateDiff as (...x: unknown[]) => Promise<Map<string, ResourceChange>>).apply(
      real,
      args
    )
  );
  diff.hasChanges.mockImplementation((c: unknown) => real.hasChanges(c as never));
  await makeEngine().deploy('s', template);

  // Which gate kept the provider from being called: the diff itself
  // (NO_CHANGE), or the engine's no-change skip over an UPDATE.
  const changes = (await diff.calculateDiff.mock.results.at(-1)!.value) as Map<
    string,
    ResourceChange
  >;
  expect(changes.get('R')?.changeType).toBe(redeployChange);
  expect(provider.update).not.toHaveBeenCalled();
  return { created, provider };
}
