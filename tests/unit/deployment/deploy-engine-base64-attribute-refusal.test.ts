import { describe, it, expect, vi } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/**
 * The `Fn::Base64` encoding of a secret reaches the deploy's masked-read
 * refusal (issue #2881), and the refusal names that cause with a remedy that
 * applies to it.
 *
 * `resolveBase64` registers the encoding as a mask-only needle (issue #2759),
 * and the deploy redacts a record's `attributes` with the same bag as its
 * `properties`. So an `AWS::SSM::Parameter` whose `Value` is built over the
 * encoding persists `***` in its `Value` ATTRIBUTE too, and a LATER deploy
 * that resolves `Fn::GetAtt [Param, Value]` for a new consumer reads the mask
 * out of state. No custom resource is anywhere near it, so the NoEcho remedy
 * (bump a nonce) cannot apply. The resolver and the diff are REAL here, so
 * this is the route, not a message rendered from a hand-built bag.
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

const PARAM_PROPS = {
  Name: '/app/ud',
  Type: 'String',
  Value: { 'Fn::Base64': { 'Fn::Join': ['', ['pw=', '{{resolve:ssm-secure:/app/pw}}']] } },
};
const CONSUMER_PROPS = {
  Name: '/app/copy',
  Type: 'String',
  Value: { 'Fn::GetAtt': ['Param', 'Value'] },
};
const encoded = Buffer.from('pw=pw-secret-value').toString('base64');

describe('DeployEngine - a Base64-encoded secret read back out of attributes (issue #2881)', () => {
  it('persists the encoding as the mask in the attribute, then refuses a later reader naming the Fn::Base64 cause', async () => {
    const provider = {
      // The SSM provider's own create() shape: the `Value` attribute echoes
      // the value it was sent.
      create: vi
        .fn()
        .mockImplementation((_id: string, _type: string, props: Record<string, unknown>) =>
          Promise.resolve({
            physicalId: String(props['Name']),
            attributes: { Type: props['Type'], Value: props['Value'] },
          })
        ),
      update: vi.fn().mockResolvedValue({ physicalId: '/app/ud', wasReplaced: false }),
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
    const levels = vi.fn().mockReturnValue([['Param']]);
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
          getExecutionLevels: levels,
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

    // Deploy 1: the parameter alone.
    const first: CloudFormationTemplate = {
      Resources: { Param: { Type: 'AWS::SSM::Parameter', Properties: PARAM_PROPS } },
    };
    diff.calculateDiff.mockResolvedValue(
      new Map([
        [
          'Param',
          {
            logicalId: 'Param',
            changeType: 'CREATE',
            resourceType: 'AWS::SSM::Parameter',
            desiredProperties: PARAM_PROPS,
          },
        ],
      ])
    );
    await makeEngine().deploy('s', first);
    // AWS really got the encoding...
    expect(provider.create.mock.calls[0]![2]).toMatchObject({ Value: encoded });
    const created = saveState.mock.calls.at(-1)![2] as StackState;
    // ...and state holds the mask in BOTH bags, which is the precondition the
    // refusal below depends on.
    expect(created.resources['Param']!.properties['Value']).toBe('***');
    expect(created.resources['Param']!.attributes?.['Value']).toBe('***');
    expect(JSON.stringify(created)).not.toContain(encoded);

    // Deploy 2: the parameter is unchanged and a NEW resource reads its
    // `Value` attribute. The diff is the real one.
    getState.mockResolvedValue({ state: created, etag: 'e' });
    diff.calculateDiff.mockImplementation((...args: unknown[]) =>
      (real.calculateDiff as (...x: unknown[]) => Promise<Map<string, ResourceChange>>).apply(
        real,
        args
      )
    );
    diff.hasChanges.mockImplementation((c: unknown) => real.hasChanges(c as never));
    levels.mockReturnValue([['Param'], ['Copy']]);
    const second: CloudFormationTemplate = {
      Resources: {
        Param: { Type: 'AWS::SSM::Parameter', Properties: PARAM_PROPS },
        Copy: { Type: 'AWS::SSM::Parameter', Properties: CONSUMER_PROPS },
      },
    };
    const failure = await makeEngine()
      .deploy('s', second)
      .then(
        () => undefined,
        (e: unknown) => e as Error & { cause?: Error }
      );

    // The consumer was never created with the mask (nor with anything).
    expect(provider.create).toHaveBeenCalledTimes(1);
    expect(failure).toBeInstanceOf(Error);
    const refusal = String(failure?.cause?.message ?? failure?.message);
    expect(refusal).toContain('Cannot resolve Param.Value for Copy');
    // The arm this issue adds, with its remedy.
    expect(refusal).toContain('three ways a record comes to hold the mask');
    expect(refusal).toContain('Fn::Base64 encoding of a secret value');
    // The remedy names the SECRET's reference, and steers away from reading
    // the String parameter that holds the encoding, which cdkd stores in the
    // clear (PR #4334 security review).
    expect(refusal).toContain("build the value itself from the SECRET's own reference");
    expect(refusal).toContain(
      'not by a {{resolve:ssm:...}} read of a String parameter holding the encoding'
    );
    expect(refusal).toContain('a re-import does not recover it');
    // The computed re-import command for `Param` (a local, re-importable
    // type) is still printed, so its lead-in must say it is for cause (3)
    // only — unscoped, the line after "a re-import does not recover it" told
    // the user to re-import (PR #4334 code review).
    expect(refusal).toMatch(/Re-import with: cdkd import .*Param=/);
    expect(refusal).toContain(
      'If cause (3) applies, re-import the record that HOLDS the mask (command(s) below); ' +
        'a re-import does not clear a cause (1) or (2) mask.'
    );
    expect(refusal).not.toMatch(/(^|\. )Re-import the record that HOLDS the mask/);
    // The message never carries the value it refuses to send.
    expect(refusal).not.toContain(encoded);
    expect(refusal).not.toContain('pw-secret-value');
  });
});
