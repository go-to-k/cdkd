import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';

const RESOURCE_TYPE = 'AWS::SSM::Parameter';

// AWS::SSM::Parameter.Tags is a key->value MAP in CloudFormation (unlike the
// {Key,Value}[] list shape most resources use). CDK synthesizes the map form,
// so a provider that does `properties['Tags'].map(...)` throws
// "Tags.map is not a function" on every tagged parameter. These tests pin the
// map handling (the bug surfaced by the context-test / infra-security integs).
describe('SSMParameterProvider Tags map shape (AWS::SSM::Parameter.Tags is a map)', () => {
  let provider: SSMParameterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SSMParameterProvider();
  });

  it('create: accepts the CFn map shape and applies it as SDK Tag[]', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand
    mockSend.mockResolvedValueOnce({}); // AddTagsToResourceCommand

    await provider.create('MyParam', RESOURCE_TYPE, {
      Name: '/foo/bar',
      Type: 'String',
      Value: 'baz',
      Tags: { Example: 'context-test', Project: 'cdkd' },
    });

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['PutParameterCommand', 'AddTagsToResourceCommand']);
    const addCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'AddTagsToResourceCommand'
    );
    expect(addCall![0].input).toEqual({
      ResourceType: 'Parameter',
      ResourceId: '/foo/bar',
      Tags: [
        { Key: 'Example', Value: 'context-test' },
        { Key: 'Project', Value: 'cdkd' },
      ],
    });
  });

  it('create: still accepts the list shape (defensive) and drops aws:* keys', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand
    mockSend.mockResolvedValueOnce({}); // AddTagsToResourceCommand

    await provider.create('MyParam', RESOURCE_TYPE, {
      Name: '/foo/bar',
      Type: 'String',
      Value: 'baz',
      Tags: { Foo: 'Bar', 'aws:cdk:path': 'MyStack/Param/Resource' },
    });

    const addCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'AddTagsToResourceCommand'
    );
    expect(addCall![0].input.Tags).toEqual([{ Key: 'Foo', Value: 'Bar' }]);
  });

  it('create: empty map does NOT fire AddTagsToResource (no tags to apply)', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand

    await provider.create('MyParam', RESOURCE_TYPE, {
      Name: '/foo/bar',
      Type: 'String',
      Value: 'baz',
      Tags: {},
    });

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['PutParameterCommand']);
  });

  it('create: coerces non-string tag values to strings (SSM tag values must be strings)', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand
    mockSend.mockResolvedValueOnce({}); // AddTagsToResourceCommand

    await provider.create('MyParam', RESOURCE_TYPE, {
      Name: '/foo/bar',
      Type: 'String',
      Value: 'baz',
      Tags: { Version: 3, Enabled: true },
    });

    const addCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'AddTagsToResourceCommand'
    );
    expect(addCall![0].input.Tags).toEqual([
      { Key: 'Version', Value: '3' },
      { Key: 'Enabled', Value: 'true' },
    ]);
  });

  it('update: diffs map shapes — added key fires AddTags, removed key fires RemoveTags', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand
    mockSend.mockResolvedValueOnce({}); // RemoveTagsFromResourceCommand
    mockSend.mockResolvedValueOnce({}); // AddTagsToResourceCommand

    await provider.update(
      'MyParam',
      '/foo/bar',
      RESOURCE_TYPE,
      { Name: '/foo/bar', Type: 'String', Value: 'baz', Tags: { Env: 'prod' } },
      { Name: '/foo/bar', Type: 'String', Value: 'baz', Tags: { Team: 'platform' } }
    );

    const removeCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'RemoveTagsFromResourceCommand'
    );
    const addCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'AddTagsToResourceCommand'
    );
    expect(removeCall![0].input.TagKeys).toEqual(['Team']);
    expect(addCall![0].input.Tags).toEqual([{ Key: 'Env', Value: 'prod' }]);
  });

  it('update: pure key-reorder (same key/value set) does NOT fire any tag mutation', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand

    await provider.update(
      'MyParam',
      '/foo/bar',
      RESOURCE_TYPE,
      { Name: '/foo/bar', Type: 'String', Value: 'baz', Tags: { A: '1', B: '2' } },
      { Name: '/foo/bar', Type: 'String', Value: 'baz', Tags: { B: '2', A: '1' } }
    );

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['PutParameterCommand']);
  });

  it('create: a non-primitive tag value (e.g. an unresolved object) coerces to empty string', async () => {
    // SSM tag values must be strings. A non-primitive (object/array) value
    // would otherwise stringify to "[object Object]"; coerce to '' instead.
    // In practice intrinsics are resolved before the provider sees them, so
    // this only documents the defensive coercion.
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand
    mockSend.mockResolvedValueOnce({}); // AddTagsToResourceCommand

    await provider.create('MyParam', RESOURCE_TYPE, {
      Name: '/foo/bar',
      Type: 'String',
      Value: 'baz',
      Tags: { Weird: { nested: 'object' }, Ok: 'fine' },
    });

    const addCall = mockSend.mock.calls.find(
      (c) => c[0].constructor.name === 'AddTagsToResourceCommand'
    );
    expect(addCall![0].input.Tags).toEqual([
      { Key: 'Weird', Value: '' },
      { Key: 'Ok', Value: 'fine' },
    ]);
  });

  it('update: unchanged map does NOT fire any tag mutation', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameterCommand

    await provider.update(
      'MyParam',
      '/foo/bar',
      RESOURCE_TYPE,
      { Name: '/foo/bar', Type: 'String', Value: 'baz', Tags: { Env: 'prod' } },
      { Name: '/foo/bar', Type: 'String', Value: 'baz', Tags: { Env: 'prod' } }
    );

    const names = mockSend.mock.calls.map((c) => c[0].constructor.name);
    expect(names).toEqual(['PutParameterCommand']);
  });
});
