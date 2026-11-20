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
import { withCcReadBackDefaultRemovals } from '../../../src/provisioning/cc-read-back-default-paths.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const TYPE = 'AWS::OpenSearchService::Domain';
const POLICY: JsonPatchOp[] = [
  { op: 'replace', path: '/AccessPolicies', value: { Version: '2012-10-17', Statement: [] } },
];
const AIML = {
  S3VectorsEngine: { Enabled: false },
  ServerlessVectorAcceleration: { Enabled: false },
};
// The read model of a domain created with neither declared (measured, #6676).
const LIVE = {
  DomainName: 'd',
  AdvancedOptions: {
    override_main_response_version: 'false',
    'rest.action.multi.allow_explicit_index': 'true',
  },
  AIMLOptions: AIML,
};
const REMOVE_OVERRIDE: JsonPatchOp = {
  op: 'remove',
  path: '/AdvancedOptions/override_main_response_version',
};
const REMOVE_AIML: JsonPatchOp = { op: 'remove', path: '/AIMLOptions' };

describe('withCcReadBackDefaultRemovals (go-to-k/cdkd#6676)', () => {
  it('removes both read-back defaults the template does not declare', () => {
    expect(withCcReadBackDefaultRemovals(TYPE, POLICY, { DomainName: 'd' }, LIVE)).toEqual([
      ...POLICY,
      REMOVE_OVERRIDE,
      REMOVE_AIML,
    ]);
  });

  it('removes them when the desired bag holds the same values (drift --revert)', () => {
    expect(withCcReadBackDefaultRemovals(TYPE, POLICY, LIVE, LIVE)).toEqual([
      ...POLICY,
      REMOVE_OVERRIDE,
      REMOVE_AIML,
    ]);
  });

  it('removes the default member of a declared AdvancedOptions that does not name it', () => {
    const desired = { AdvancedOptions: { 'rest.action.multi.allow_explicit_index': 'true' } };
    expect(withCcReadBackDefaultRemovals(TYPE, POLICY, desired, LIVE)).toContainEqual(
      REMOVE_OVERRIDE
    );
  });

  it('keeps a declared value that differs from the measured default', () => {
    const desired = { AdvancedOptions: { override_main_response_version: 'true' } };
    const live = { ...LIVE, AdvancedOptions: { override_main_response_version: 'true' } };
    expect(withCcReadBackDefaultRemovals(TYPE, POLICY, desired, live)).toEqual([
      ...POLICY,
      REMOVE_AIML,
    ]);
  });

  it('keeps a live value that is not the measured default (an enabled feature)', () => {
    const live = { AIMLOptions: { S3VectorsEngine: { Enabled: true } } };
    expect(withCcReadBackDefaultRemovals(TYPE, POLICY, {}, live)).toBe(POLICY);
  });

  it('adds no remove when the live model lacks the path (a missing-path remove fails the patch)', () => {
    expect(withCcReadBackDefaultRemovals(TYPE, POLICY, {}, { DomainName: 'd' })).toBe(POLICY);
  });

  it('leaves a path the patch already touches, at it, above it or below it', () => {
    for (const op of [
      { op: 'replace', path: '/AdvancedOptions', value: { a: 'b' } },
      { op: 'remove', path: '/AdvancedOptions' },
      { op: 'add', path: '/AIMLOptions/S3VectorsEngine', value: { Enabled: true } },
    ] as JsonPatchOp[]) {
      const out = withCcReadBackDefaultRemovals(TYPE, [op], {}, LIVE);
      expect(out.filter((o) => o.op === 'remove' && o !== op)).toHaveLength(1);
    }
  });

  it('returns the same array for an unlisted type, an empty patch, or no live model', () => {
    expect(withCcReadBackDefaultRemovals('AWS::Logs::LogGroup', POLICY, {}, LIVE)).toBe(POLICY);
    const empty: JsonPatchOp[] = [];
    expect(withCcReadBackDefaultRemovals(TYPE, empty, {}, LIVE)).toBe(empty);
    expect(withCcReadBackDefaultRemovals(TYPE, POLICY, {}, undefined)).toBe(POLICY);
  });
});

describe('CloudControlProvider.update wiring (go-to-k/cdkd#6676)', () => {
  let sentPatch: JsonPatchOp[] | undefined;

  beforeEach(() => {
    mockCcSend.mockReset();
    sentPatch = undefined;
    mockCcSend.mockImplementation((command: unknown) => {
      if (command instanceof GetResourceCommand) {
        return Promise.resolve({
          ResourceDescription: { Properties: JSON.stringify({ ...LIVE, AccessPolicies: {} }) },
        });
      }
      if (command instanceof UpdateResourceCommand) {
        sentPatch = JSON.parse(command.input.PatchDocument as string) as JsonPatchOp[];
        return Promise.reject(new Error('stop after UpdateResource'));
      }
      return Promise.reject(new Error(`unexpected command ${String(command)}`));
    });
  });

  it('reads the live model for a listed type and sends the removes after the change', async () => {
    await new CloudControlProvider()
      .update(
        'Domain',
        'd',
        TYPE,
        { DomainName: 'd', AccessPolicies: { Version: '2012-10-17', Statement: [] } },
        { DomainName: 'd', AccessPolicies: {} }
      )
      .catch(() => undefined);

    expect(mockCcSend.mock.calls.filter(([c]) => c instanceof GetResourceCommand)).toHaveLength(1);
    expect(sentPatch).toEqual([...POLICY, REMOVE_OVERRIDE, REMOVE_AIML]);
  });
});
