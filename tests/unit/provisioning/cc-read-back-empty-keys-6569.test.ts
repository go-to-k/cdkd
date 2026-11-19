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

// go-to-k/cdkd#6581: the shared-read case needs a nested create-only gap; every
// other case runs with none.
let createOnlyPaths: string[][] = [];
vi.mock('../../../src/provisioning/create-only-properties.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/provisioning/create-only-properties.js')>()),
  getCreateOnlyPropertyPaths: () => Promise.resolve(createOnlyPaths),
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { withCcReadBackEmptyKeyRemovals } from '../../../src/provisioning/cc-read-back-empty-keys.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const TYPE = 'AWS::ImageBuilder::InfrastructureConfiguration';
const CHANGE: JsonPatchOp[] = [{ op: 'replace', path: '/InstanceTypes', value: ['t3.small'] }];
const REMOVE_TAGS: JsonPatchOp = { op: 'remove', path: '/ResourceTags' };

describe('withCcReadBackEmptyKeyRemovals (go-to-k/cdkd#6569)', () => {
  it('removes a read-back empty ResourceTags the template does not declare', () => {
    const out = withCcReadBackEmptyKeyRemovals(
      TYPE,
      CHANGE,
      { Name: 'infra' },
      {
        Name: 'infra',
        ResourceTags: {},
      }
    );
    expect(out).toEqual([...CHANGE, REMOVE_TAGS]);
  });

  it('removes it when the desired bag holds the read-back empty value too (drift --revert)', () => {
    expect(
      withCcReadBackEmptyKeyRemovals(TYPE, CHANGE, { ResourceTags: {} }, { ResourceTags: {} })
    ).toEqual([...CHANGE, REMOVE_TAGS]);
  });

  it('treats an empty list read-back as empty', () => {
    expect(withCcReadBackEmptyKeyRemovals(TYPE, CHANGE, {}, { ResourceTags: [] })).toEqual([
      ...CHANGE,
      REMOVE_TAGS,
    ]);
  });

  it('adds no remove when the live model lacks the key (a missing-path remove fails the patch)', () => {
    const out = withCcReadBackEmptyKeyRemovals(TYPE, CHANGE, {}, { Name: 'infra' });
    expect(out).toBe(CHANGE);
  });

  it('keeps a non-empty live value', () => {
    const out = withCcReadBackEmptyKeyRemovals(TYPE, CHANGE, {}, { ResourceTags: { a: 'b' } });
    expect(out).toBe(CHANGE);
  });

  it('keeps the request when the desired bag declares a non-empty value', () => {
    const out = withCcReadBackEmptyKeyRemovals(
      TYPE,
      CHANGE,
      { ResourceTags: { a: 'b' } },
      { ResourceTags: {} }
    );
    expect(out).toBe(CHANGE);
  });

  it('leaves an op the patch already has on the key as written', () => {
    const patch: JsonPatchOp[] = [
      ...CHANGE,
      { op: 'add', path: '/ResourceTags', value: { a: 'b' } },
    ];
    const out = withCcReadBackEmptyKeyRemovals(
      TYPE,
      patch,
      { ResourceTags: { a: 'b' } },
      { ResourceTags: {} }
    );
    expect(out).toBe(patch);
  });

  it('turns a replace OF an empty map into a remove (revert of a {} baseline over tags added out of band)', () => {
    const patch: JsonPatchOp[] = [...CHANGE, { op: 'replace', path: '/ResourceTags', value: {} }];
    expect(
      withCcReadBackEmptyKeyRemovals(TYPE, patch, { ResourceTags: {} }, { ResourceTags: { a: 'b' } })
    ).toEqual([...CHANGE, REMOVE_TAGS]);
  });

  it('drops an add OF an empty map when the live model lacks the key', () => {
    const patch: JsonPatchOp[] = [...CHANGE, { op: 'add', path: '/ResourceTags', value: [] }];
    expect(withCcReadBackEmptyKeyRemovals(TYPE, patch, { ResourceTags: [] }, {})).toEqual(CHANGE);
  });

  it('returns the same array for an unlisted type, an empty patch, or no live model', () => {
    expect(
      withCcReadBackEmptyKeyRemovals('AWS::Logs::LogGroup', CHANGE, {}, { ResourceTags: {} })
    ).toBe(CHANGE);
    const empty: JsonPatchOp[] = [];
    expect(withCcReadBackEmptyKeyRemovals(TYPE, empty, {}, { ResourceTags: {} })).toBe(empty);
    expect(withCcReadBackEmptyKeyRemovals(TYPE, CHANGE, {}, undefined)).toBe(CHANGE);
  });

  it('does not list the empty read-backs measured to update fine', () => {
    const out = withCcReadBackEmptyKeyRemovals(
      TYPE,
      CHANGE,
      {},
      { Tags: {}, SecurityGroupIds: [], Logging: { S3Logs: {} } }
    );
    expect(out).toBe(CHANGE);
  });
});

describe('CloudControlProvider.update wiring (go-to-k/cdkd#6569)', () => {
  let sentPatch: JsonPatchOp[] | undefined;

  beforeEach(() => {
    mockCcSend.mockReset();
    sentPatch = undefined;
    mockCcSend.mockImplementation((command: unknown) => {
      if (command instanceof GetResourceCommand) {
        return Promise.resolve({
          ResourceDescription: {
            Properties: JSON.stringify({
              Name: 'infra',
              InstanceTypes: ['t3.micro'],
              ResourceTags: {},
              Tags: {},
            }),
          },
        });
      }
      if (command instanceof UpdateResourceCommand) {
        sentPatch = JSON.parse(command.input.PatchDocument as string) as JsonPatchOp[];
        // The patch is what this asserts; ending the update here is enough.
        return Promise.reject(new Error('stop after UpdateResource'));
      }
      return Promise.reject(new Error(`unexpected command ${String(command)}`));
    });
  });

  const getResourceCalls = (): number =>
    mockCcSend.mock.calls.filter(([c]) => c instanceof GetResourceCommand).length;

  it('reads the live model for a listed type and sends the remove', async () => {
    await new CloudControlProvider()
      .update(
        'Infra',
        'arn:aws:imagebuilder:us-east-1:123456789012:infrastructure-configuration/infra',
        TYPE,
        { Name: 'infra', InstanceTypes: ['t3.small'] },
        { Name: 'infra', InstanceTypes: ['t3.micro'] }
      )
      .catch(() => undefined);

    expect(getResourceCalls()).toBe(1);
    expect(sentPatch).toEqual([
      { op: 'replace', path: '/InstanceTypes', value: ['t3.small'] },
      REMOVE_TAGS,
    ]);
  });

  it('works on drift --revert, whose desired bag carries the read-back empty map', async () => {
    await new CloudControlProvider()
      .update(
        'Infra',
        'arn:aws:imagebuilder:us-east-1:123456789012:infrastructure-configuration/infra',
        TYPE,
        { Name: 'infra', InstanceTypes: ['t3.micro'], ResourceTags: {} },
        { Name: 'infra', InstanceTypes: ['t3.large'], ResourceTags: {} },
        { desiredFromAwsReadback: true }
      )
      .catch(() => undefined);

    expect(sentPatch).toContainEqual(REMOVE_TAGS);
  });

  it('sends no UpdateResource when the only op set an empty map the live model lacks', async () => {
    mockCcSend.mockImplementation((command: unknown) =>
      command instanceof GetResourceCommand
        ? Promise.resolve({
            ResourceDescription: { Properties: JSON.stringify({ Name: 'infra' }) },
          })
        : Promise.reject(new Error(`unexpected command ${String(command)}`))
    );
    const result = await new CloudControlProvider().update(
      'Infra',
      'arn:aws:imagebuilder:us-east-1:123456789012:infrastructure-configuration/infra',
      TYPE,
      { Name: 'infra', ResourceTags: {} },
      { Name: 'infra' }
    );
    expect(result).toMatchObject({ wasReplaced: false, sentNothing: true });
    expect(
      mockCcSend.mock.calls.some(([c]) => c instanceof UpdateResourceCommand)
    ).toBe(false);
  });

  it('shares one GetResource with the nested gap carry (go-to-k/cdkd#6581)', async () => {
    createOnlyPaths = [['InstanceMetadataOptions', 'HttpEndpoint']];
    mockCcSend.mockImplementation((command: unknown) => {
      if (command instanceof GetResourceCommand) {
        return Promise.resolve({
          ResourceDescription: {
            Properties: JSON.stringify({
              Name: 'infra',
              ResourceTags: {},
              InstanceMetadataOptions: { HttpEndpoint: 'enabled', HttpTokens: 'optional' },
            }),
          },
        });
      }
      if (command instanceof UpdateResourceCommand) {
        sentPatch = JSON.parse(command.input.PatchDocument as string) as JsonPatchOp[];
        return Promise.reject(new Error('stop after UpdateResource'));
      }
      return Promise.reject(new Error(`unexpected command ${String(command)}`));
    });
    try {
      await new CloudControlProvider()
        .update(
          'Infra',
          'arn:aws:imagebuilder:us-east-1:123456789012:infrastructure-configuration/infra',
          TYPE,
          { Name: 'infra', InstanceMetadataOptions: { HttpTokens: 'required' } },
          { Name: 'infra', InstanceMetadataOptions: { HttpTokens: 'optional' } }
        )
        .catch(() => undefined);
    } finally {
      createOnlyPaths = [];
    }

    expect(getResourceCalls()).toBe(1);
    expect(sentPatch).toContainEqual(REMOVE_TAGS);
    expect(sentPatch).toContainEqual({
      op: 'replace',
      path: '/InstanceMetadataOptions',
      value: { HttpTokens: 'required', HttpEndpoint: 'enabled' },
    });
  });

  it('sends no GetResource for an unlisted type', async () => {
    await new CloudControlProvider()
      .update(
        'Group',
        'my-group',
        'AWS::Logs::LogGroup',
        { LogGroupName: 'my-group', RetentionInDays: 7 },
        { LogGroupName: 'my-group', RetentionInDays: 1 }
      )
      .catch(() => undefined);

    expect(getResourceCalls()).toBe(0);
    expect(sentPatch).toEqual([{ op: 'replace', path: '/RetentionInDays', value: 7 }]);
  });
});
