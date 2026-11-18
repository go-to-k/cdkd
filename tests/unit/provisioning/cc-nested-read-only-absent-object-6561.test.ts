import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6561: an Athena workgroup's configuration update is sent as a
// whole-object op on `WorkGroupConfiguration` that omits `EngineVersion` (the
// template never declares it). Cloud Control applies it to the model it reads,
// where AWS filled `EngineVersion` in, so the op drops the read-only
// `EngineVersion.EffectiveEngineVersion` and the update is refused. An object
// absent from BOTH the previous and the desired properties is carried whole
// from the live model; under one the template removed, only a MEASURED
// read-only leaf's chain is carried (`REMOVED_BLOCK_LEAF_CARRY`; for Athena,
// CloudFormation resets the removed writable member to its default and keeps
// the read-only leaf), and any other path is carried nowhere (#6554).

const mockCloudControlSend = vi.hoisted(() => vi.fn());
const mockCloudFormationSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => child),
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import {
  nestedReadOnlyGaps,
  withRemovedBlockDefaults,
} from '../../../src/provisioning/cc-nested-create-only-patch.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';
import { clearReadOnlyPropertiesCache } from '../../../src/provisioning/read-only-properties.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';

const EFFECTIVE = ['WorkGroupConfiguration', 'EngineVersion', 'EffectiveEngineVersion'];

describe('nestedReadOnlyGaps: an object above the leaf absent from both sides (go-to-k/cdkd#6561)', () => {
  const op = (value: unknown): JsonPatchOp[] => [{ op: 'add', path: '/WorkGroupConfiguration', value }];

  it('lists the absent object whole when the previous properties lack it too', () => {
    expect(
      nestedReadOnlyGaps(op({ EnforceWorkGroupConfiguration: true }), [EFFECTIVE], {
        WorkGroupConfiguration: { EnforceWorkGroupConfiguration: false },
      })
    ).toEqual([['WorkGroupConfiguration', 'EngineVersion']]);
    // A previous side without the top-level key never declared the object either.
    expect(nestedReadOnlyGaps(op({}), [EFFECTIVE], {})).toEqual([
      ['WorkGroupConfiguration', 'EngineVersion'],
    ]);
  });

  it('lists only a MEASURED leaf under an object the template removed (the previous properties hold it)', () => {
    const removed = {
      WorkGroupConfiguration: { EngineVersion: { SelectedEngineVersion: 'AUTO' } },
    };
    const patch = op({ EnforceWorkGroupConfiguration: true });
    expect(nestedReadOnlyGaps(patch, [EFFECTIVE], removed, 'AWS::Athena::WorkGroup')).toEqual([
      EFFECTIVE,
    ]);
    // The same shape on a type or a leaf the list does not name: nothing (#6554).
    expect(nestedReadOnlyGaps(patch, [EFFECTIVE], removed, 'AWS::Other::Type')).toEqual([]);
    expect(nestedReadOnlyGaps(patch, [EFFECTIVE], removed)).toEqual([]);
    // A type named like an Object.prototype key reads no prototype member.
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(nestedReadOnlyGaps(patch, [EFFECTIVE], removed, type)).toEqual([]);
    }
    expect(
      nestedReadOnlyGaps(
        patch,
        [['WorkGroupConfiguration', 'EngineVersion', 'Other']],
        removed,
        'AWS::Athena::WorkGroup'
      )
    ).toEqual([]);
  });

  it('lists nothing for an absent object without previous properties', () => {
    expect(nestedReadOnlyGaps(op({ EnforceWorkGroupConfiguration: true }), [EFFECTIVE])).toEqual([]);
  });

  it('still lists the leaf alone when its parent object is present', () => {
    expect(
      nestedReadOnlyGaps(op({ EngineVersion: { SelectedEngineVersion: 'AUTO' } }), [EFFECTIVE], {})
    ).toEqual([EFFECTIVE]);
  });

  it('lists the TOPMOST absent object once, for every leaf below it', () => {
    const leaves = [
      ['Catalog', 'Sync', 'Assets', 'Details'],
      ['Catalog', 'Sync', 'Lineage', 'Details'],
    ];
    expect(
      nestedReadOnlyGaps([{ op: 'replace', path: '/Catalog', value: { Name: 'n' } }], leaves, {
        Catalog: { Name: 'm' },
      })
    ).toEqual([['Catalog', 'Sync']]);
    // Present on the previous side at the topmost absent level: removed, and
    // no leaf here is a measured one, so nothing.
    expect(
      nestedReadOnlyGaps([{ op: 'replace', path: '/Catalog', value: { Name: 'n' } }], leaves, {
        Catalog: { Name: 'm', Sync: {} },
      })
    ).toEqual([]);
  });

  it('lists nothing through a non-object in the op value', () => {
    expect(nestedReadOnlyGaps(op({ EngineVersion: 'x' }), [EFFECTIVE], {})).toEqual([]);
  });
});

describe('withRemovedBlockDefaults (go-to-k/cdkd#6561)', () => {
  const TYPE = 'AWS::Athena::WorkGroup';
  const REMOVED = {
    WorkGroupConfiguration: { EngineVersion: { SelectedEngineVersion: 'Athena engine version 3' } },
  };
  const op = (value: unknown): JsonPatchOp[] => [{ op: 'add', path: '/WorkGroupConfiguration', value }];

  it('writes the removed object as its measured writable defaults, on a copy', () => {
    const value = { EnforceWorkGroupConfiguration: true };
    expect(withRemovedBlockDefaults(op(value), REMOVED, TYPE)).toEqual(
      op({ EnforceWorkGroupConfiguration: true, EngineVersion: { SelectedEngineVersion: 'AUTO' } })
    );
    expect(value).toEqual({ EnforceWorkGroupConfiguration: true });
  });

  it('leaves the op alone when the template still declares the object or never did', () => {
    const declared = op({ EngineVersion: { SelectedEngineVersion: 'Athena engine version 3' } });
    expect(withRemovedBlockDefaults(declared, REMOVED, TYPE)).toEqual(declared);
    const never = op({ EnforceWorkGroupConfiguration: true });
    expect(withRemovedBlockDefaults(never, { WorkGroupConfiguration: {} }, TYPE)).toEqual(never);
  });

  it('writes nothing for a type the list does not name, prototype keys included', () => {
    const patch = op({ EnforceWorkGroupConfiguration: true });
    for (const type of ['AWS::Other::Type', 'constructor', 'toString', '__proto__']) {
      expect(withRemovedBlockDefaults(patch, REMOVED, type)).toEqual(patch);
    }
  });
});

describe('CloudControlProvider update: an Athena workgroup configuration change (go-to-k/cdkd#6561)', () => {
  let provider: CloudControlProvider;
  let liveModel: Record<string, unknown>;

  const TYPE = 'AWS::Athena::WorkGroup';
  // The live schema's shape: the top-level reduction of the nested write-only
  // paths makes `WorkGroupConfiguration` write-only, so its op is an `add`.
  const SCHEMA = JSON.stringify({
    readOnlyProperties: [
      '/properties/CreationTime',
      '/properties/WorkGroupConfiguration/EngineVersion/EffectiveEngineVersion',
    ],
    writeOnlyProperties: [
      '/properties/RecursiveDeleteOption',
      '/properties/WorkGroupConfiguration/AdditionalConfiguration',
    ],
    createOnlyProperties: ['/properties/Name'],
  });
  const ENGINE = { SelectedEngineVersion: 'AUTO', EffectiveEngineVersion: 'Athena engine version 3' };

  function configurationOps(): unknown[] {
    return mockCloudControlSend.mock.calls
      .map((c) => c[0] as { constructor: { name: string }; input: { PatchDocument?: string } })
      .filter((cmd) => cmd.constructor.name === 'UpdateResourceCommand')
      .flatMap((cmd) => JSON.parse(cmd.input.PatchDocument!) as Array<{ path: string }>)
      .filter((patchOp) => patchOp.path === '/WorkGroupConfiguration');
  }

  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
    clearReadOnlyPropertiesCache();
    clearCreateOnlyPropertiesCache();
    mockCloudFormationSend.mockResolvedValue({ Schema: SCHEMA });
    liveModel = {
      Name: 'wg',
      CreationTime: '2026-11-18T00:00:00Z',
      WorkGroupConfiguration: {
        EnforceWorkGroupConfiguration: true,
        BytesScannedCutoffPerQuery: 10000000,
        ResultConfiguration: { OutputLocation: 's3://b/results/' },
        EngineVersion: ENGINE,
      },
    };
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'UpdateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({ ProgressEvent: { OperationStatus: 'SUCCESS', Identifier: 'wg' } });
      }
      if (name === 'GetResourceCommand') {
        return Promise.resolve({
          ResourceDescription: { Identifier: 'wg', Properties: JSON.stringify(liveModel) },
        });
      }
      return Promise.resolve({});
    });
    provider = new CloudControlProvider();
  });

  const PREVIOUS = {
    Name: 'wg',
    RecursiveDeleteOption: true,
    WorkGroupConfiguration: {
      EnforceWorkGroupConfiguration: true,
      BytesScannedCutoffPerQuery: 10000000,
      ResultConfiguration: { OutputLocation: 's3://b/results/' },
    },
  };
  const DESIRED_CONFIGURATION = {
    EnforceWorkGroupConfiguration: false,
    BytesScannedCutoffPerQuery: 20000000,
    ResultConfiguration: { OutputLocation: 's3://b/results-v2/' },
  };

  it('carries the live EngineVersion whole when neither side declares it', async () => {
    await provider.update(
      'Wg',
      'wg',
      TYPE,
      { ...PREVIOUS, WorkGroupConfiguration: DESIRED_CONFIGURATION },
      PREVIOUS
    );

    expect(configurationOps()).toEqual([
      {
        op: 'add',
        path: '/WorkGroupConfiguration',
        value: { ...DESIRED_CONFIGURATION, EngineVersion: ENGINE },
      },
    ]);
  });

  it('sends a removed EngineVersion as its measured defaults plus the live read-only leaf', async () => {
    await provider.update(
      'Wg',
      'wg',
      TYPE,
      { ...PREVIOUS, WorkGroupConfiguration: DESIRED_CONFIGURATION },
      {
        ...PREVIOUS,
        WorkGroupConfiguration: {
          ...PREVIOUS.WorkGroupConfiguration,
          EngineVersion: { SelectedEngineVersion: 'Athena engine version 3' },
        },
      }
    );

    expect(configurationOps()).toEqual([
      {
        op: 'add',
        path: '/WorkGroupConfiguration',
        value: {
          ...DESIRED_CONFIGURATION,
          // The measured CloudFormation end state: the leaf alone is refused
          // by Athena (`The selected engine version is not valid`).
          EngineVersion: {
            SelectedEngineVersion: 'AUTO',
            EffectiveEngineVersion: 'Athena engine version 3',
          },
        },
      },
    ]);
  });

  it('carries only the leaf when the template declares EngineVersion', async () => {
    const declared = { ...DESIRED_CONFIGURATION, EngineVersion: { SelectedEngineVersion: 'AUTO' } };
    await provider.update(
      'Wg',
      'wg',
      TYPE,
      { ...PREVIOUS, WorkGroupConfiguration: declared },
      {
        ...PREVIOUS,
        WorkGroupConfiguration: {
          ...PREVIOUS.WorkGroupConfiguration,
          EngineVersion: { SelectedEngineVersion: 'AUTO' },
        },
      }
    );

    expect(configurationOps()).toEqual([
      {
        op: 'add',
        path: '/WorkGroupConfiguration',
        value: { ...declared, EngineVersion: ENGINE },
      },
    ]);
  });

  it('sends the template object unchanged when the live model holds no EngineVersion', async () => {
    liveModel = { Name: 'wg', WorkGroupConfiguration: { EnforceWorkGroupConfiguration: true } };

    await provider.update(
      'Wg',
      'wg',
      TYPE,
      { ...PREVIOUS, WorkGroupConfiguration: DESIRED_CONFIGURATION },
      PREVIOUS
    );

    expect(configurationOps()).toEqual([
      { op: 'add', path: '/WorkGroupConfiguration', value: DESIRED_CONFIGURATION },
    ]);
  });
});
