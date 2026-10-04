import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { maskedPropertyFingerprint } from '../../../src/deployment/masked-property-fingerprints.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';

/**
 * A redeploy of an UNCHANGED template whose property is `Fn::Base64` over a
 * `{{resolve:...}}` input sends nothing (go-to-k/cdkd#3662 review round), and
 * an EDIT around that reference is sent (go-to-k/cdkd#4451).
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
 *
 * `***` == `***` also hid every edit AROUND the reference (#4451): the record
 * now carries a fingerprint of the UNRESOLVED template value, and both the
 * diff and the skip treat a moved one as a change.
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
// The SecureString value each `GetParameter` returns, by parameter name, so
// a test can rotate one.
const secretValues = new Map<string, string>();
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: {
      send: vi.fn((command: { input: { Name: string } }) =>
        Promise.resolve({
          Parameter: {
            Value: secretValues.get(command.input.Name) ?? 'pw-secret-value',
            Type: 'SecureString',
          },
        })
      ),
    },
  }),
}));
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

beforeEach(() => {
  secretValues.clear();
});

const base64Value = (script: string, reference = '{{resolve:ssm-secure:/app/pw}}'): unknown => ({
  'Fn::Base64': { 'Fn::Join': ['', [script, reference]] },
});
const PROPS = {
  Name: '/app/ud',
  Type: 'String',
  Value: base64Value('pw='),
};
// go-to-k/cdkd#2453: the same encoding EMBEDDED in a longer leaf, which a
// whole-leaf-only mask left decodable in state.
const embedded = (inner: unknown): Record<string, unknown> => ({
  Name: '/app/ud',
  Type: 'String',
  Value: { 'Fn::Join': ['', ['#!/bin/bash\nUD=', inner, '\n']] },
});
const EMBEDDED_PROPS = embedded(PROPS.Value);
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

  it('records the fingerprint of the UNRESOLVED template value, never of anything resolved (go-to-k/cdkd#4451)', async () => {
    const h = harness();
    const created = await h.deploy(PROPS);
    expect(created.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: maskedPropertyFingerprint(PROPS.Value),
    });
    // Only the masked property is fingerprinted.
    expect(Object.keys(created.resources['R']!.maskedPropertyFingerprints!)).toEqual(['Value']);
    const json = JSON.stringify(created);
    expect(json).not.toContain('pw-secret-value');
    expect(json).not.toContain(encoded);
  });

  it('a rotated secret behind an unchanged template sends nothing (CloudFormation parity)', async () => {
    for (const props of [PROPS, EMBEDDED_PROPS]) {
      const h = harness();
      await h.deploy(props);
      secretValues.set('/app/pw', 'rotated-secret-value');
      const after = await h.deploy(props);
      expect(h.provider.update).not.toHaveBeenCalled();
      expect(after.resources['R']!.maskedPropertyFingerprints).toEqual({
        Value: maskedPropertyFingerprint(props.Value),
      });
    }
  });
});

describe('DeployEngine - an edit around a secret reference inside Fn::Base64 is sent (go-to-k/cdkd#4451)', () => {
  const cases: Array<{
    name: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
    sent: string;
    diff: 'UPDATE';
  }> = [
    {
      name: 'whole-leaf Fn::Base64, text around the reference edited',
      before: PROPS,
      after: { ...PROPS, Value: base64Value('echo B\npw=') },
      sent: Buffer.from('echo B\npw=pw-secret-value').toString('base64'),
      diff: 'UPDATE',
    },
    {
      name: 'whole-leaf Fn::Base64, reference retargeted',
      before: PROPS,
      after: { ...PROPS, Value: base64Value('pw=', '{{resolve:ssm-secure:/app/other}}') },
      sent: Buffer.from('pw=other-secret-value').toString('base64'),
      diff: 'UPDATE',
    },
    {
      name: 'Fn::Base64 EMBEDDED in a longer leaf, text around the reference edited',
      before: EMBEDDED_PROPS,
      after: embedded(base64Value('echo B\npw=')),
      sent: `#!/bin/bash\nUD=${Buffer.from('echo B\npw=pw-secret-value').toString('base64')}\n`,
      diff: 'UPDATE',
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      secretValues.set('/app/other', 'other-secret-value');
      const h = harness();
      await h.deploy(c.before);
      const after = await h.deploy(c.after);
      expect(h.lastChange()?.changeType).toBe(c.diff);
      expect(h.provider.update).toHaveBeenCalledTimes(1);
      // The NEW value reached the provider, resolved.
      const sent = (h.provider.update.mock.calls[0]![3] as Record<string, unknown>)['Value'];
      expect(sent).toBe(c.sent);
      // The record now describes the new template, so a third deploy of it is
      // a no-op again.
      expect(after.resources['R']!.properties['Value']).toBe('***');
      expect(after.resources['R']!.maskedPropertyFingerprints).toEqual({
        Value: maskedPropertyFingerprint(c.after['Value']),
      });
      await h.deploy(c.after);
      expect(h.provider.update).toHaveBeenCalledTimes(1);
    });
  }

  it('a record WITHOUT the field (an older cdkd) behaves as before, is backfilled, and the NEXT edit is sent', async () => {
    const h = harness();
    const created = await h.deploy(PROPS);
    // What an older cdkd wrote: the same record without the field.
    const { maskedPropertyFingerprints: _dropped, ...legacy } = created.resources['R']!;
    h.setState({ ...created, resources: { R: legacy } });

    // The upgrade deploy of an UNCHANGED template sends nothing...
    const upgraded = await h.deploy(PROPS);
    expect(h.provider.update).not.toHaveBeenCalled();
    // ...and saves the backfilled fingerprint (the no-change path's trigger).
    expect(upgraded.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: maskedPropertyFingerprint(PROPS.Value),
    });

    // The next edit around the reference reaches AWS.
    await h.deploy({ ...PROPS, Value: base64Value('echo B\npw=') });
    expect(h.provider.update).toHaveBeenCalledTimes(1);
  });

  it('a record WITHOUT the field and an edited template sends nothing, as before the field existed', async () => {
    // No evidence of what AWS holds: the first deploy under this version
    // keeps the old comparison rather than updating every such resource.
    for (const props of [PROPS, EMBEDDED_PROPS]) {
      const h = harness();
      const created = await h.deploy(props);
      const { maskedPropertyFingerprints: _dropped, ...legacy } = created.resources['R']!;
      h.setState({ ...created, resources: { R: legacy } });
      const edited =
        props === PROPS
          ? { ...PROPS, Value: base64Value('echo B\npw=') }
          : embedded(base64Value('echo B\npw='));
      await h.deploy(edited);
      expect(h.provider.update).not.toHaveBeenCalled();
    }
  });

  it('a FAILED update keeps the previous fingerprint, so the retry still sends the edit', async () => {
    const h = harness();
    await h.deploy(PROPS);
    const edited = { ...PROPS, Value: base64Value('echo B\npw=') };
    h.provider.update.mockRejectedValueOnce(new Error('boom'));
    await expect(h.deploy(edited, { noRollback: true })).rejects.toThrow();
    const failed = h.saved();
    expect(failed.resources['R']!.maskedPropertyFingerprints).toEqual({
      Value: maskedPropertyFingerprint(PROPS.Value),
    });
    expect(h.provider.update).toHaveBeenCalledTimes(1);

    await h.deploy(edited);
    expect(h.provider.update).toHaveBeenCalledTimes(2);
  });
});

interface Harness {
  deploy(props: Record<string, unknown>, options?: { noRollback?: boolean }): Promise<StackState>;
  saved(): StackState;
  setState(state: StackState): void;
  lastChange(): ResourceChange | undefined;
  provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

/**
 * The real resolver and diff, with the state backend, lock and provider
 * doubled. Each `deploy` reads the state the previous one saved.
 */
function harness(): Harness {
  const provider = {
    create: vi.fn().mockResolvedValue({ physicalId: 'p' }),
    update: vi.fn().mockResolvedValue({ physicalId: 'p', wasReplaced: false }),
    delete: vi.fn(),
    getAttribute: vi.fn(),
    readCurrentState: vi.fn().mockResolvedValue(undefined),
  };
  let state: StackState | null = null;
  const saveState = vi.fn((_stack: string, _region: string, saved: StackState) => {
    state = saved;
    return Promise.resolve('etag');
  });
  const getState = vi.fn(() =>
    Promise.resolve({ state, etag: state === null ? undefined : 'e' })
  );
  const real = new DiffCalculator();
  let last: Map<string, ResourceChange> | undefined;
  const diff = {
    calculateDiff: vi.fn(async (...args: unknown[]) => {
      last = await (
        real.calculateDiff as (...x: unknown[]) => Promise<Map<string, ResourceChange>>
      ).apply(real, args);
      return last;
    }),
    hasChanges: vi.fn((c: unknown) => real.hasChanges(c as never)),
    filterByType: vi
      .fn()
      .mockImplementation((c: Map<string, ResourceChange>, t: string) =>
        [...c.values()].filter((x) => x.changeType === t)
      ),
  };
  const makeEngine = (noRollback: boolean): DeployEngine =>
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
      { dryRun: false, noRollback },
      'us-east-1'
    );
  return {
    async deploy(props, options) {
      const template: CloudFormationTemplate = {
        Resources: { R: { Type: 'AWS::SSM::Parameter', Properties: props } },
      };
      await makeEngine(options?.noRollback ?? false).deploy('s', template);
      return state!;
    },
    saved: () => state!,
    setState(next) {
      state = next;
    },
    lastChange: () => last?.get('R'),
    provider,
  };
}

async function createThenRedeploy(
  props: Record<string, unknown>,
  redeployChange: 'NO_CHANGE' | 'UPDATE'
): Promise<{ created: StackState; provider: Harness['provider'] }> {
  const h = harness();
  const created = await h.deploy(props);
  expect(created.resources['R']!.properties['Value']).toBe('***');

  // The redeploy runs the REAL diff over the record the create wrote.
  await h.deploy(props);

  // Which gate kept the provider from being called: the diff itself
  // (NO_CHANGE), or the engine's no-change skip over an UPDATE.
  expect(h.lastChange()?.changeType).toBe(redeployChange);
  expect(h.provider.update).not.toHaveBeenCalled();
  return { created, provider: h.provider };
}
