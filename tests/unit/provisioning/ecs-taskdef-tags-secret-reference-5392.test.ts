import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #5392 + go-to-k/cdkd#4275: state records a secret-derived leaf as its
 * `{{resolve:...}}` reference while `update()` receives the resolved value, so
 * a TaskDefinition whose container environment reads a secret must still
 * take a tags-only change in place, and still refuse a real change.
 */
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  child.child = vi.fn().mockReturnValue(child);
  return { getLogger: () => child };
});

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';

const SECRET = 'ecs-5392-secret-env-value';
const REFERENCE = '{{resolve:secretsmanager:db:SecretString:password}}';
const maskSecrets = createSecretMasker(new Map([[SECRET, REFERENCE]]));
const TD_ARN = 'arn:aws:ecs:us-east-1:123456789012:task-definition/my-task:4';

const containers = (value: string) => [
  { Name: 'web', Image: 'nginx:latest', Environment: [{ Name: 'PASSWORD', Value: value }] },
];

describe('ECSProvider TaskDefinition tags-only update behind a secret reference (#5392)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('tags the revision when the only other difference is a resolved reference', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider().update(
      'MyTask',
      TD_ARN,
      'AWS::ECS::TaskDefinition',
      { Family: 'my-task', ContainerDefinitions: containers(SECRET), Tags: [{ Key: 'k', Value: 'v2' }] },
      { Family: 'my-task', ContainerDefinitions: containers(REFERENCE), Tags: [{ Key: 'k', Value: 'v1' }] },
      { maskSecrets }
    );

    const sent = mockSend.mock.calls.map((c) => [c[0].constructor.name, c[0].input]);
    expect(sent).toEqual([
      ['TagResourceCommand', { resourceArn: TD_ARN, tags: [{ key: 'k', value: 'v2' }] }],
    ]);
  });

  it('still refuses when a value other than the reference moved', async () => {
    await expect(
      provider().update(
        'MyTask',
        TD_ARN,
        'AWS::ECS::TaskDefinition',
        { Family: 'my-task', ContainerDefinitions: containers('a-different-value'), Tags: [] },
        { Family: 'my-task', ContainerDefinitions: containers(REFERENCE), Tags: [] },
        { maskSecrets }
      )
    ).rejects.toMatchObject({ name: 'ResourceUpdateNotSupportedError' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

function provider(): ECSProvider {
  return new ECSProvider();
}
