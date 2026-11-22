import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { GetResourceCommand, UpdateResourceCommand } from '@aws-sdk/client-cloudcontrol';

const mockCcSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCcSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

vi.mock('../../../src/provisioning/create-only-properties.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/create-only-properties.js')>()),
  getCreateOnlyPropertyPaths: () => Promise.resolve([]),
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { withCcReadBackExclusiveKeyRemovals } from '../../../src/provisioning/cc-read-back-exclusive-keys.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const ALIAS = 'AWS::StepFunctions::StateMachineAlias';
const FLOW = 'AWS::Bedrock::Flow';
const V2 = 'arn:aws:states:us-east-1:123456789012:stateMachine:sm:2';
const PREFERENCE = { StateMachineVersionArn: V2, Type: 'ALL_AT_ONCE' };
const SET_PREFERENCE: JsonPatchOp[] = [
  { op: 'add', path: '/DeploymentPreference', value: PREFERENCE },
];
// The read model of an alias created with DeploymentPreference (measured, #6818).
const ALIAS_LIVE = {
  Arn: 'arn:aws:states:us-east-1:123456789012:stateMachine:sm:a',
  Name: 'a',
  RoutingConfiguration: [{ StateMachineVersionArn: `${V2.slice(0, -1)}1`, Weight: 100 }],
};
const REMOVE_ROUTING: JsonPatchOp = { op: 'remove', path: '/RoutingConfiguration' };
const FLOW_LIVE = { Id: 'f', Name: 'f', Definition: { Nodes: [], Connections: [] } };
const REMOVE_DEFINITION: JsonPatchOp = { op: 'remove', path: '/Definition' };

function reader(model: Record<string, unknown> | undefined) {
  return vi.fn(() => Promise.resolve(model));
}

describe('withCcReadBackExclusiveKeyRemovals (go-to-k/cdkd#6818, go-to-k/cdkd#6819)', () => {
  it("removes an alias's read-back RoutingConfiguration when the patch writes DeploymentPreference", async () => {
    for (const op of ['add', 'replace'] as const) {
      const patch: JsonPatchOp[] = [{ ...SET_PREFERENCE[0]!, op }];
      expect(
        await withCcReadBackExclusiveKeyRemovals(ALIAS, patch, {}, reader(ALIAS_LIVE))
      ).toEqual([...patch, REMOVE_ROUTING]);
    }
  });

  it("removes a flow's read-back Definition when the patch writes DefinitionString or DefinitionS3Location", async () => {
    for (const path of ['/DefinitionString', '/DefinitionS3Location']) {
      const patch: JsonPatchOp[] = [{ op: 'add', path, value: 'x' }];
      expect(await withCcReadBackExclusiveKeyRemovals(FLOW, patch, {}, reader(FLOW_LIVE))).toEqual(
        [...patch, REMOVE_DEFINITION]
      );
    }
  });

  it('does not read the live model when the patch writes no listed key', async () => {
    const read = reader(ALIAS_LIVE);
    const patch: JsonPatchOp[] = [{ op: 'replace', path: '/Description', value: 'd' }];
    expect(await withCcReadBackExclusiveKeyRemovals(ALIAS, patch, {}, read)).toBe(patch);
    // A `remove` of the write-only key is not a write of it.
    const removal: JsonPatchOp[] = [{ op: 'remove', path: '/DeploymentPreference' }];
    expect(await withCcReadBackExclusiveKeyRemovals(ALIAS, removal, {}, read)).toBe(removal);
    expect(read).not.toHaveBeenCalled();
  });

  it('leaves the read-back key the desired bag declares or the patch already touches', async () => {
    const read = reader(ALIAS_LIVE);
    const declared = { RoutingConfiguration: ALIAS_LIVE.RoutingConfiguration };
    expect(await withCcReadBackExclusiveKeyRemovals(ALIAS, SET_PREFERENCE, declared, read)).toBe(
      SET_PREFERENCE
    );
    const touched: JsonPatchOp[] = [...SET_PREFERENCE, REMOVE_ROUTING];
    expect(await withCcReadBackExclusiveKeyRemovals(ALIAS, touched, {}, read)).toBe(touched);
    expect(read).not.toHaveBeenCalled();
  });

  it('adds no remove when the live model lacks the key (a missing-path remove fails the patch)', async () => {
    const patch: JsonPatchOp[] = [{ op: 'add', path: '/DefinitionString', value: 'x' }];
    expect(await withCcReadBackExclusiveKeyRemovals(FLOW, patch, {}, reader({ Id: 'f' }))).toBe(
      patch
    );
  });

  it('adds no remove when the live model cannot be read', async () => {
    const patch: JsonPatchOp[] = [{ op: 'add', path: '/DefinitionString', value: 'x' }];
    const read = reader(undefined);
    expect(await withCcReadBackExclusiveKeyRemovals(FLOW, patch, {}, read)).toBe(patch);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('returns the same array for an unlisted type', async () => {
    const read = reader(ALIAS_LIVE);
    expect(
      await withCcReadBackExclusiveKeyRemovals('AWS::Logs::LogGroup', SET_PREFERENCE, {}, read)
    ).toBe(SET_PREFERENCE);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('CloudControlProvider.update wiring (go-to-k/cdkd#6818, go-to-k/cdkd#6819)', () => {
  let sentPatch: JsonPatchOp[] | undefined;
  let live: Record<string, unknown>;

  beforeEach(() => {
    mockCcSend.mockReset();
    sentPatch = undefined;
    mockCcSend.mockImplementation((command: unknown) => {
      if (command instanceof GetResourceCommand) {
        return Promise.resolve({ ResourceDescription: { Properties: JSON.stringify(live) } });
      }
      if (command instanceof UpdateResourceCommand) {
        sentPatch = JSON.parse(command.input.PatchDocument as string) as JsonPatchOp[];
        return Promise.reject(new Error('stop after UpdateResource'));
      }
      return Promise.reject(new Error(`unexpected command ${String(command)}`));
    });
  });

  it("sends a changed alias DeploymentPreference with the read-back RoutingConfiguration removed", async () => {
    live = ALIAS_LIVE;
    await new CloudControlProvider()
      .update(
        'Alias',
        ALIAS_LIVE.Arn,
        ALIAS,
        { Name: 'a', DeploymentPreference: PREFERENCE },
        { Name: 'a', DeploymentPreference: { ...PREFERENCE, StateMachineVersionArn: 'v1' } }
      )
      .catch(() => undefined);

    expect(mockCcSend.mock.calls.filter(([c]) => c instanceof GetResourceCommand)).toHaveLength(1);
    expect(sentPatch).toEqual([
      { op: 'replace', path: '/DeploymentPreference', value: PREFERENCE },
      REMOVE_ROUTING,
    ]);
  });

  it('pays no GetResource on an alias update that leaves DeploymentPreference alone', async () => {
    live = ALIAS_LIVE;
    await new CloudControlProvider()
      .update(
        'Alias',
        ALIAS_LIVE.Arn,
        ALIAS,
        { Name: 'a', Description: 'new', DeploymentPreference: PREFERENCE },
        { Name: 'a', Description: 'old', DeploymentPreference: PREFERENCE }
      )
      .catch(() => undefined);

    expect(mockCcSend.mock.calls.filter(([c]) => c instanceof GetResourceCommand)).toHaveLength(0);
    expect(sentPatch).toEqual([{ op: 'replace', path: '/Description', value: 'new' }]);
  });

  it('sends a changed flow DefinitionString with the read-back Definition removed', async () => {
    live = FLOW_LIVE;
    await new CloudControlProvider()
      .update(
        'Flow',
        'f',
        FLOW,
        { Name: 'f', DefinitionString: '{"Nodes":[1]}' },
        { Name: 'f', DefinitionString: '{"Nodes":[]}' }
      )
      .catch(() => undefined);

    expect(sentPatch).toEqual([
      { op: 'replace', path: '/DefinitionString', value: '{"Nodes":[1]}' },
      REMOVE_DEFINITION,
    ]);
  });
});
