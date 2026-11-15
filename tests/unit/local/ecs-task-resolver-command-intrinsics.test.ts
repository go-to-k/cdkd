/**
 * go-to-k/cdkd#6271: a container `Command` / `EntryPoint` /
 * `HealthCheck.Command` element that is an intrinsic used to be dropped
 * silently, so `cdkd local run-task` ran a different command
 * (`--bucket` with no value). Each element now resolves against state, and
 * one that cannot resolve refuses the run naming the container and index.
 */
import { describe, expect, it, vi } from 'vite-plus/test';
import {
  applyCrossStackResolverToTask,
  assertEcsTaskCommandsResolved,
  detectEcsImageResolutionNeeds,
  EcsTaskResolutionError,
  resolveEcsTaskTarget,
} from '../../../src/local/ecs-task-resolver.js';
import type { ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';
import { type JudgedValue, ProducerSecretReader } from '../../../src/local/cross-stack-secrets.js';
import { argvValue } from '../../../src/local/ecs-task-resolver/container.js';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner/docker-run-args.js';
import type { CrossStackResolver } from '../../../src/local/state-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { TemplateResource } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

function buildStack(container: Record<string, unknown>): StackInfo {
  const resources: Record<string, TemplateResource> = {
    B08E7C7AF: { Type: 'AWS::S3::Bucket', Properties: {} },
    TD: {
      Type: 'AWS::ECS::TaskDefinition',
      Properties: {
        Family: 'fam',
        NetworkMode: 'bridge',
        ContainerDefinitions: [{ Name: 'cli', Image: 'busybox:latest', ...container }],
      },
    },
  };
  return {
    stackName: 'S1',
    displayName: 'S1',
    artifactId: 'S1',
    template: { Resources: resources },
    dependencyNames: [],
  };
}

function bucketState(): Record<string, ResourceState> {
  return {
    B08E7C7AF: {
      physicalId: 'deployed-bucket-123',
      resourceType: 'AWS::S3::Bucket',
      properties: {},
      attributes: { Arn: 'arn:aws:s3:::deployed-bucket-123' },
      dependencies: [],
    },
  };
}

/** The `docker run` argv the runner builds for the task's first container. */
function dockerArgs(task: ResolvedEcsTask): string[] {
  const container = task.containers[0]!;
  return buildDockerRunArgs({
    task,
    container,
    image: 'img',
    network: 'net',
    volumeByName: new Map(task.volumes.map((v) => [v.name, v])),
    secrets: [],
    plaintextEnvKeys: container.resolvedDynamicReferenceKeys ?? [],
    envOverrides: undefined,
    containerHost: '127.0.0.1',
    roleArn: undefined,
    platformOverride: undefined,
    region: 'us-east-1',
  }).args;
}

const envFlags = (args: string[]): string[] => args.flatMap((a, i) => (args[i - 1] === '-e' ? [a] : []));

const bucketCommand = ['s3api', 'head-bucket', '--bucket', { Ref: 'B08E7C7AF' }];

describe('container argv intrinsics (go-to-k/cdkd#6271)', () => {
  it('substitutes a Ref element of Command against state, keeping its position', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: bucketCommand })], {
      stateResources: bucketState(),
    });
    expect(task.containers[0]!.command).toEqual([
      's3api',
      'head-bucket',
      '--bucket',
      'deployed-bucket-123',
    ]);
    expect(task.containers[0]!.unresolvedCommandElements).toBeUndefined();
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('substitutes EntryPoint and HealthCheck.Command elements (Fn::GetAtt / Fn::Join)', () => {
    const task = resolveEcsTaskTarget(
      'TD',
      [
        buildStack({
          EntryPoint: ['sh', '-c', { 'Fn::Join': ['', ['echo ', { Ref: 'B08E7C7AF' }]] }],
          HealthCheck: { Command: ['CMD', 'test', { 'Fn::GetAtt': ['B08E7C7AF', 'Arn'] }] },
        }),
      ],
      { stateResources: bucketState() }
    );
    const c = task.containers[0]!;
    expect(c.entryPoint).toEqual(['sh', '-c', 'echo deployed-bucket-123']);
    expect(c.healthCheck?.command).toEqual(['CMD', 'test', 'arn:aws:s3:::deployed-bucket-123']);
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('refuses, naming the container and index, when there is no state source', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: bucketCommand })]);
    expect(task.containers[0]!.unresolvedCommandElements).toEqual([
      { field: 'Command', index: 3, reason: expect.stringContaining('--from-state') },
    ]);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(EcsTaskResolutionError);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Container 'cli' Command\[3\]/);
  });

  it('refuses when the referenced resource is missing from state', () => {
    const task = resolveEcsTaskTarget(
      'TD',
      [buildStack({ HealthCheck: { Command: ['CMD', { Ref: 'B08E7C7AF' }] } })],
      { stateResources: {} }
    );
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
      /Container 'cli' HealthCheck\.Command\[1\]/
    );
  });

  it('refuses an EntryPoint element that is not a string or an intrinsic', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ EntryPoint: ['sh', null] })], {
      stateResources: bucketState(),
    });
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Container 'cli' EntryPoint\[1\]/);
  });

  it('keeps number and boolean literals as their strings', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['sleep', 5, true] })]);
    expect(task.containers[0]!.command).toEqual(['sleep', '5', 'true']);
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('stringifies an element that substitutes to a number', () => {
    const state = bucketState();
    state['B08E7C7AF']!.attributes = { Port: 5432 };
    const task = resolveEcsTaskTarget(
      'TD',
      [buildStack({ Command: ['--port', { 'Fn::GetAtt': ['B08E7C7AF', 'Port'] }] })],
      { stateResources: state }
    );
    expect(task.containers[0]!.command).toEqual(['--port', '5432']);
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('does not refuse an all-literal Command with no state source', () => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['echo', 'hi'] })]);
    expect(task.containers[0]!.command).toEqual(['echo', 'hi']);
    expect(task.containers[0]!.unresolvedCommandElements).toBeUndefined();
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('flags an intrinsic argv element as needing state, a cross-stack one the resolver too', () => {
    const same = detectEcsImageResolutionNeeds(buildStack({ Command: bucketCommand }));
    expect(same.needsEnvOrSecretSubstitution).toBe(true);
    expect(same.needsCrossStackResolver).toBe(false);
    const cross = detectEcsImageResolutionNeeds(
      buildStack({ HealthCheck: { Command: ['CMD', { 'Fn::ImportValue': 'P-Bucket' }] } })
    );
    expect(cross.needsEnvOrSecretSubstitution).toBe(true);
    expect(cross.needsCrossStackResolver).toBe(true);
    // Nested in Fn::Join: cdk-local resolves it now, so the resolver is built
    // for it too (go-to-k/cdkd#6270).
    const nested = detectEcsImageResolutionNeeds(
      buildStack({
        Command: ['cp', { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'P-Bucket' }]] }],
      })
    );
    expect(nested.needsCrossStackResolver).toBe(true);
    const literal = detectEcsImageResolutionNeeds(buildStack({ Command: ['echo', 'hi'] }));
    expect(literal.needsEnvOrSecretSubstitution).toBe(false);
  });

  describe('a secret read from state never lands on the argv', () => {
    const secretState: Record<string, ResourceState> = {
      Key: {
        physicalId: 'AKIAEXAMPLE',
        resourceType: 'AWS::IAM::AccessKey',
        properties: {},
        attributes: { SecretAccessKey: 'plaintext-secret-key' },
        dependencies: [],
      },
      ApiKey: {
        // `<apiId>|<apiKeyId>`: the key id IS the x-api-key value.
        physicalId: 'apiid123|da2-plaintext-api-key',
        resourceType: 'AWS::AppSync::ApiKey',
        properties: {},
        attributes: {
          ApiKey: 'da2-plaintext-api-key',
          ApiKeyId: 'da2-plaintext-api-key',
          Arn: 'arn:aws:appsync:us-east-1:123456789012:apis/apiid123/apikeys/da2-plaintext-api-key',
        },
        dependencies: [],
      },
      // A nested stack row whose `Outputs.Key` passes a child's secret up
      // (`secretNamedAttributes`, go-to-k/cdkd#3869).
      Child: {
        physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/child/1',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: {},
        attributes: { 'Outputs.Key': 'child-plaintext-key', 'Outputs.Bucket': 'child-bucket' },
        secretNamedAttributes: ['Outputs.Key'],
        dependencies: [],
      },
      Cr: {
        physicalId: 'cr-1',
        resourceType: 'Custom::Thing',
        properties: {},
        attributes: { Token: '***', Name: 'cr-name' },
        dependencies: [],
      },
    };
    const resolve = (command: unknown[]) =>
      resolveEcsTaskTarget('TD', [buildStack({ Command: command })], {
        stateResources: secretState,
      });

    it.each([
      ['a credential-named attribute', { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] }, 'Key.SecretAccessKey'],
      ['a dotted-string Fn::GetAtt', { 'Fn::GetAtt': 'Key.SecretAccessKey' }, 'Key.SecretAccessKey'],
      ['a secret-valued attribute inside Fn::Sub', { 'Fn::Sub': 'x-api-key: ${ApiKey.ApiKey}' }, 'ApiKey.ApiKey'],
      // go-to-k/cdkd#6238: `ApiKeyId` is the same key, under CloudFormation's other name.
      ['the API key read as ApiKeyId', { 'Fn::GetAtt': ['ApiKey', 'ApiKeyId'] }, 'ApiKey.ApiKeyId'],
      [
        'a secret attribute inside an array-form Fn::Sub (CDK emits it with variables)',
        { 'Fn::Sub': ['${Key.SecretAccessKey}-${Suffix}', { Suffix: 'x' }] },
        'Key.SecretAccessKey',
      ],
      // go-to-k/cdkd#6330: the ApiKey's `Arn` ends in the key.
      ['an attribute holding the secret physical-id segment', { 'Fn::GetAtt': ['ApiKey', 'Arn'] }, 'ApiKey.Arn'],
      ['such an attribute inside Fn::Sub', { 'Fn::Sub': 'arn=${ApiKey.Arn}' }, 'ApiKey.Arn'],
      // go-to-k/cdkd#6330: a nested stack output the row names as a secret.
      ['a nested stack output named secret', { 'Fn::GetAtt': ['Child', 'Outputs.Key'] }, 'Child.Outputs.Key'],
      ['a nested stack output named secret, dotted', { 'Fn::GetAtt': 'Child.Outputs.Key' }, 'Child.Outputs.Key'],
      ['an attribute recorded as the mask', { 'Fn::Join': ['', ['t=', { 'Fn::GetAtt': ['Cr', 'Token'] }]] }, 'Cr.Token'],
    ])('refuses %s', (_label, element, named) => {
      const task = resolve(['run', element]);
      expect(task.containers[0]!.command).toEqual(['run', '']);
      expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        new RegExp(`Command\\[1\\]: reads the secret attribute ${named.replace('.', '\\.')}`)
      );
    });

    it('does not treat an escaped ${!Id.Attr} literal as a secret read', () => {
      // cdk-local's engine refuses the escape on its own; the secret guard
      // must not be what fires.
      const task = resolve(['echo', { 'Fn::Sub': 'literal ${!Key.SecretAccessKey}' }]);
      const [u] = task.containers[0]!.unresolvedCommandElements!;
      expect(u!.reason).not.toMatch(/reads the secret attribute/);
    });

    it('still resolves a nested stack output the row does not name as a secret', () => {
      const task = resolve(['run', { 'Fn::GetAtt': ['Child', 'Outputs.Bucket'] }]);
      expect(task.containers[0]!.command).toEqual(['run', 'child-bucket']);
    });

    it('passes a secret-read Environment value value-less (secret attribute, mask, nested output)', () => {
      const task = resolveEcsTaskTarget(
        'TD',
        [
          buildStack({
            Environment: [
              { Name: 'SAK', Value: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] } },
              { Name: 'CHILD', Value: { 'Fn::GetAtt': ['Child', 'Outputs.Key'] } },
              { Name: 'BUCKET', Value: { 'Fn::GetAtt': ['Child', 'Outputs.Bucket'] } },
            ],
          }),
        ],
        { stateResources: secretState }
      );
      const args = dockerArgs(task);
      expect(args.join(' ')).not.toMatch(/plaintext/);
      expect(envFlags(args)).toEqual(expect.arrayContaining(['SAK', 'CHILD', 'BUCKET=child-bucket']));
    });

    it('drops a Secrets ValueFrom whose recorded value is a secret, naming no value', () => {
      const secrets = [
        { Name: 'KEY', ValueFrom: { 'Fn::GetAtt': ['ApiKey', 'ApiKey'] } },
        { Name: 'SAK', ValueFrom: { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] } },
        { Name: 'MASKED', ValueFrom: { 'Fn::GetAtt': ['Cr', 'Token'] } },
        { Name: 'CHILD', ValueFrom: { 'Fn::GetAtt': ['Child', 'Outputs.Key'] } },
      ];
      const task = resolveEcsTaskTarget('TD', [buildStack({ Secrets: secrets })], { stateResources: secretState });
      const c = task.containers[0]!;
      expect(c.secrets).toEqual([]);
      expect(JSON.stringify(c)).not.toMatch(/plaintext|\*\*\*/);
      expect(c.warnings).toEqual([
        expect.stringMatching(/^Secret 'KEY' dropped: ValueFrom reads ApiKey\.ApiKey, which holds a secret/),
        expect.stringMatching(/^Secret 'SAK' dropped: ValueFrom reads Key\.SecretAccessKey, which holds a secret/),
        expect.stringMatching(/^Secret 'MASKED' dropped: ValueFrom reads Cr\.Token, which holds a secret/),
        expect.stringMatching(/^Secret 'CHILD' dropped: ValueFrom reads Child\.Outputs\.Key, which holds a secret/),
      ]);
    });

    // CDK's `ecs.Secret.fromSecretsManager(secret)` with the secret in a nested
    // stack: the output's NAME matches the secret heuristic, its value is the ARN.
    it('resolves a nested-stack secret ARN output as a ValueFrom and a Host.SourcePath, whatever its name', () => {
      const state: Record<string, ResourceState> = {
        Nested: {
          physicalId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/nested/1',
          resourceType: 'AWS::CloudFormation::Stack',
          properties: {},
          attributes: {
            'Outputs.AppDbStackDbSecret1234ABCDRef': 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-AbCdEf',
            'Outputs.SecretDirRef': '/tmp/secret-dir',
          },
          dependencies: [],
        },
      };
      const stack = buildStack({
        Secrets: [{ Name: 'DB', ValueFrom: { 'Fn::GetAtt': ['Nested', 'Outputs.AppDbStackDbSecret1234ABCDRef'] } }],
        MountPoints: [{ SourceVolume: 'v', ContainerPath: '/data' }],
      });
      const td = stack.template.Resources!['TD']!.Properties as Record<string, unknown>;
      td['Volumes'] = [{ Name: 'v', Host: { SourcePath: { 'Fn::GetAtt': ['Nested', 'Outputs.SecretDirRef'] } } }];
      const task = resolveEcsTaskTarget('TD', [stack], { stateResources: state });
      expect(task.containers[0]!.secrets).toEqual([
        { name: 'DB', valueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-AbCdEf' },
      ]);
      expect(task.containers[0]!.warnings).toEqual([]);
      expect(dockerArgs(task)).toContain('/tmp/secret-dir:/data');
    });

    it('still resolves a non-secret attribute of the same custom resource', () => {
      const task = resolve(['run', { 'Fn::GetAtt': ['Cr', 'Name'] }]);
      expect(task.containers[0]!.command).toEqual(['run', 'cr-name']);
      expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
    });

    // go-to-k/cdkd#6330: a Ref resolves to the recorded physical id, which for
    // an AppSync ApiKey is `<apiId>|<key>`.
    describe('a Ref to a record whose physical id holds a secret', () => {
      it.each([
        ['a Ref', { Ref: 'ApiKey' }],
        ['a dot-less Fn::Sub placeholder', { 'Fn::Sub': 'x-api-key: ${ApiKey}' }],
        ['a dot-less placeholder of an array-form Fn::Sub', { 'Fn::Sub': ['${ApiKey}-${Suffix}', { Suffix: 'x' }] }],
        ['a Ref in an array-form Fn::Sub variable', { 'Fn::Sub': ['k=${K}', { K: { Ref: 'ApiKey' } }] }],
        ['a Ref nested in Fn::Join', { 'Fn::Join': ['', ['k=', { Ref: 'ApiKey' }]] }],
      ])('refuses %s', (_label, element) => {
        const task = resolve(['run', element]);
        expect(task.containers[0]!.command).toEqual(['run', '']);
        expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
        expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
          /Command\[1\]: references ApiKey, whose physical id holds a secret, .*pass the value through Environment or Secrets instead/
        );
      });

      it('refuses it in EntryPoint and HealthCheck.Command too', () => {
        const task = resolveEcsTaskTarget(
          'TD',
          [buildStack({ EntryPoint: [{ Ref: 'ApiKey' }], HealthCheck: { Command: ['CMD', { Ref: 'ApiKey' }] } })],
          { stateResources: secretState }
        );
        expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
        expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/EntryPoint\[0\]: references ApiKey/);
        expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/HealthCheck\.Command\[1\]: references ApiKey/);
      });

      it('refuses an ApiKey recorded under its ARN', () => {
        const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['run', { Ref: 'ApiKey' }] })], {
          stateResources: {
            ApiKey: {
              ...secretState['ApiKey']!,
              physicalId: 'arn:aws:appsync:us-east-1:123456789012:apis/apiid123/apikeys/da2-plaintext-api-key',
            },
          },
        });
        expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
        expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Command\[1\]: references ApiKey/);
      });

      it('does not treat an escaped ${!ApiKey} literal as a Ref', () => {
        const task = resolve(['echo', { 'Fn::Sub': 'literal ${!ApiKey}' }]);
        for (const u of task.containers[0]!.unresolvedCommandElements ?? []) {
          expect(u.reason).not.toMatch(/references ApiKey/);
        }
        expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
      });

      it('does not treat a name the variable map defines as a Ref', () => {
        const task = resolve(['echo', { 'Fn::Sub': ['${ApiKey}', { ApiKey: 'not-the-key' }] }]);
        expect(task.containers[0]!.command).toEqual(['echo', 'not-the-key']);
        expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
      });

      it('still resolves a Ref to a record whose physical id is no secret, beside a pseudo parameter', () => {
        const task = resolveEcsTaskTarget(
          'TD',
          [
            buildStack({
              Command: ['run', { Ref: 'Key' }, { 'Fn::Sub': '${AWS::Region}/${Key}' }, { Ref: 'AWS::Region' }],
            }),
          ],
          { stateResources: secretState, pseudoParameters: { region: 'us-east-1' } }
        );
        expect(task.containers[0]!.command).toEqual(['run', 'AKIAEXAMPLE', 'us-east-1/AKIAEXAMPLE', 'us-east-1']);
        expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
      });

      it('still resolves it in Environment, passed value-less off the argv', () => {
        const task = resolveEcsTaskTarget(
          'TD',
          [
            buildStack({
              Environment: [
                { Name: 'API_KEY', Value: { Ref: 'ApiKey' } },
                { Name: 'API_KEY_ATTR', Value: { 'Fn::GetAtt': ['ApiKey', 'ApiKey'] } },
                { Name: 'API_KEY_ARN', Value: { 'Fn::GetAtt': ['ApiKey', 'Arn'] } },
                { Name: 'KEY_ID', Value: { Ref: 'Key' } },
              ],
            }),
          ],
          { stateResources: secretState }
        );
        const c = task.containers[0]!;
        expect(c.environment).toEqual({
          API_KEY: 'apiid123|da2-plaintext-api-key',
          API_KEY_ATTR: 'da2-plaintext-api-key',
          API_KEY_ARN: 'arn:aws:appsync:us-east-1:123456789012:apis/apiid123/apikeys/da2-plaintext-api-key',
          KEY_ID: 'AKIAEXAMPLE',
        });
        expect(c.resolvedDynamicReferenceKeys).toEqual(['API_KEY', 'API_KEY_ATTR', 'API_KEY_ARN']);
        const args = dockerArgs(task);
        expect(args.join(' ')).not.toMatch(/plaintext/);
        expect(envFlags(args)).toEqual(expect.arrayContaining(['API_KEY', 'API_KEY_ATTR', 'API_KEY_ARN', 'KEY_ID=AKIAEXAMPLE']));
      });

      it('drops a Secrets ValueFrom that reads the key, naming no value, and keeps an ARN one', async () => {
        const state: Record<string, ResourceState> = {
          ...secretState,
          Sm: {
            physicalId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-AbCdEf',
            resourceType: 'AWS::SecretsManager::Secret',
            properties: {},
            attributes: {},
            dependencies: [],
          },
        };
        const secrets = [
          { Name: 'BY_REF', ValueFrom: { Ref: 'ApiKey' } },
          { Name: 'BY_ARN', ValueFrom: { 'Fn::GetAtt': ['ApiKey', 'Arn'] } },
          { Name: 'CROSS', ValueFrom: { 'Fn::Join': [':', [{ 'Fn::ImportValue': 'P' }, { Ref: 'ApiKey' }]] } },
          { Name: 'DB', ValueFrom: { Ref: 'Sm' } },
        ];
        const task = resolveEcsTaskTarget('TD', [buildStack({ Secrets: secrets })], { stateResources: state });
        await applyCrossStackResolverToTask(task, {
          resources: state,
          crossStackResolver: {
            resolveImport: vi.fn().mockResolvedValue('producer'),
            resolveGetStackOutput: vi.fn().mockResolvedValue(undefined),
          },
        });
        const c = task.containers[0]!;
        expect(c.secrets).toEqual([
          { name: 'DB', valueFrom: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-AbCdEf' },
        ]);
        expect(JSON.stringify(c)).not.toMatch(/plaintext/);
        expect(c.warnings).toEqual(
          expect.arrayContaining([
            expect.stringMatching(/^Secret 'BY_REF' dropped: ValueFrom reads ApiKey, which holds a secret/),
            expect.stringMatching(/^Secret 'BY_ARN' dropped: ValueFrom reads ApiKey\.Arn, which holds a secret/),
            expect.stringMatching(/^Secret 'CROSS' dropped: ValueFrom reads ApiKey, which holds a secret/),
          ])
        );
      });

      it.each([
        ['unrecorded', undefined],
        ['an object', { Nested: 'apiid123|da2-plaintext-api-key' }],
      ])('refuses an ApiKey attribute whose recorded value is %s, which cannot be checked for the key', (_l, stored) => {
        const state: Record<string, ResourceState> = {
          ApiKey: { ...secretState['ApiKey']!, attributes: stored === undefined ? {} : { Blob: stored } },
        };
        const task = resolveEcsTaskTarget(
          'TD',
          [buildStack({ Command: ['run', { 'Fn::GetAtt': ['ApiKey', 'Blob'] }] })],
          { stateResources: state }
        );
        expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
        expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
          /Command\[1\]: reads the secret attribute ApiKey\.Blob/
        );
      });

      it('still resolves a numeric ApiKey attribute, which cannot hold the key', () => {
        const state: Record<string, ResourceState> = {
          ApiKey: { ...secretState['ApiKey']!, attributes: { Expires: 1767225600 } },
        };
        const task = resolveEcsTaskTarget(
          'TD',
          [buildStack({ Command: ['run', { 'Fn::GetAtt': ['ApiKey', 'Expires'] }] })],
          { stateResources: state }
        );
        expect(task.containers[0]!.command).toEqual(['run', '1767225600']);
      });

      it('refuses a Host.SourcePath that reads the key, before any -v reaches the argv', () => {
        const stack = buildStack({ MountPoints: [{ SourceVolume: 'v', ContainerPath: '/data' }] });
        const td = stack.template.Resources!['TD']!.Properties as Record<string, unknown>;
        td['Volumes'] = [{ Name: 'v', Host: { SourcePath: { 'Fn::Join': ['', ['/tmp/', { Ref: 'ApiKey' }]] } } }];
        let args: string[] = [];
        let error: unknown;
        try {
          args = dockerArgs(resolveEcsTaskTarget('TD', [stack], { stateResources: secretState }));
        } catch (err) {
          error = err;
        }
        expect(args.join(' ')).not.toMatch(/plaintext/);
        expect(String(error)).toMatch(/Volumes\[0\] 'v' Host\.SourcePath reads ApiKey, which holds a secret; .*as a -v path/);
        expect(String(error)).not.toMatch(/plaintext/);
      });

      it.each([
        ['an AccessKey secret', { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] }, 'Key\\.SecretAccessKey'],
        ['a nested stack output named secret', { 'Fn::GetAtt': ['Child', 'Outputs.Key'] }, 'Child\\.Outputs\\.Key'],
      ])('refuses a Host.SourcePath that reads %s, before any -v reaches the argv', (_l, read, named) => {
        const stack = buildStack({ MountPoints: [{ SourceVolume: 'v', ContainerPath: '/data' }] });
        const td = stack.template.Resources!['TD']!.Properties as Record<string, unknown>;
        td['Volumes'] = [{ Name: 'v', Host: { SourcePath: { 'Fn::Join': ['', ['/tmp/', read]] } } }];
        let args: string[] = [];
        let error: unknown;
        try {
          args = dockerArgs(resolveEcsTaskTarget('TD', [stack], { stateResources: secretState }));
        } catch (err) {
          error = err;
        }
        expect(args.join(' ')).not.toMatch(/plaintext/);
        expect(String(error)).toMatch(new RegExp(`Host\\.SourcePath reads ${named}, which holds a secret`));
      });

      it('still mounts a Host.SourcePath that Refs a non-secret record', () => {
        const stack = buildStack({ MountPoints: [{ SourceVolume: 'v', ContainerPath: '/data' }] });
        const td = stack.template.Resources!['TD']!.Properties as Record<string, unknown>;
        td['Volumes'] = [{ Name: 'v', Host: { SourcePath: { 'Fn::Join': ['', ['/tmp/', { Ref: 'Key' }]] } } }];
        const args = dockerArgs(resolveEcsTaskTarget('TD', [stack], { stateResources: secretState }));
        expect(args).toContain('/tmp/AKIAEXAMPLE:/data');
      });

      it('keeps a cross-stack Environment value that Refs a same-stack ApiKey off the argv', async () => {
        const env = [
          { Name: 'K', Value: { 'Fn::Join': [':', [{ 'Fn::ImportValue': 'Producer-Bucket' }, { Ref: 'ApiKey' }]] } },
          { Name: 'B', Value: { 'Fn::ImportValue': 'Producer-Bucket' } },
        ];
        const task = resolveEcsTaskTarget('TD', [buildStack({ Environment: env })], { stateResources: secretState });
        await applyCrossStackResolverToTask(task, {
          resources: secretState,
          crossStackResolver: {
            resolveImport: vi.fn().mockResolvedValue('producer-bucket'),
            resolveGetStackOutput: vi.fn().mockResolvedValue(undefined),
          },
        });
        expect(task.containers[0]!.environment['K']).toBe('producer-bucket:apiid123|da2-plaintext-api-key');
        const args = dockerArgs(task);
        expect(args.join(' ')).not.toMatch(/plaintext/);
        expect(envFlags(args)).toEqual(expect.arrayContaining(['K', 'B=producer-bucket']));
      });
    });
  });

  describe('cross-stack post-pass', () => {
    function resolver(value: string | undefined): CrossStackResolver {
      return {
        resolveImport: vi.fn().mockResolvedValue(value),
        resolveGetStackOutput: vi.fn().mockResolvedValue(undefined),
      };
    }
    const importCommand = ['--bucket', { 'Fn::ImportValue': 'Producer-Bucket' }];

    it('patches a Fn::ImportValue element the sync pass left unresolved', async () => {
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })], {
        stateResources: {},
      });
      expect(task.containers[0]!.unresolvedCommandElements).toHaveLength(1);
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('producer-bucket'),
      });
      expect(task.containers[0]!.command).toEqual(['--bucket', 'producer-bucket']);
      expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
    });

    it('resolves a Fn::ImportValue nested in Fn::Join (go-to-k/cdkd#6270, cdk-local#965)', async () => {
      const nested = ['--uri', { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'Producer-Bucket' }]] }];
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: nested })], {
        stateResources: {},
      });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('producer-bucket'),
      });
      expect(task.containers[0]!.command).toEqual(['--uri', 's3://producer-bucket']);
      expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
    });

    it('refuses a nested cross-stack element that also reads a same-stack secret (go-to-k/cdkd#6270)', async () => {
      // The sync pass defers a cross-stack element before its secret check,
      // so the post-pass must run that check itself.
      const state: Record<string, ResourceState> = {
        Key: {
          physicalId: 'AKIAEXAMPLE',
          resourceType: 'AWS::IAM::AccessKey',
          properties: {},
          attributes: { SecretAccessKey: 'plaintext-secret-key' },
          dependencies: [],
        },
      };
      const element = {
        'Fn::Join': [':', [{ 'Fn::ImportValue': 'Producer-Bucket' }, { 'Fn::GetAtt': ['Key', 'SecretAccessKey'] }]],
      };
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['run', element] })], {
        stateResources: state,
      });
      await applyCrossStackResolverToTask(task, {
        resources: state,
        crossStackResolver: resolver('producer-bucket'),
      });
      expect(task.containers[0]!.command).toEqual(['run', '']);
      expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        /Command\[1\]: reads the secret attribute Key\.SecretAccessKey/
      );
    });

    it('refuses a nested cross-stack element that also Refs a same-stack ApiKey (go-to-k/cdkd#6330)', async () => {
      const state: Record<string, ResourceState> = {
        ApiKey: {
          physicalId: 'apiid123|da2-plaintext-api-key',
          resourceType: 'AWS::AppSync::ApiKey',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      };
      const element = { 'Fn::Join': [':', [{ 'Fn::ImportValue': 'Producer-Bucket' }, { Ref: 'ApiKey' }]] };
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['run', element] })], {
        stateResources: state,
      });
      await applyCrossStackResolverToTask(task, {
        resources: state,
        crossStackResolver: resolver('producer-bucket'),
      });
      expect(task.containers[0]!.command).toEqual(['run', '']);
      expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Command\[1\]: references ApiKey/);
    });

    it('refuses a producer output recorded as the secret mask (go-to-k/cdkd#6270)', async () => {
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })], {
        stateResources: {},
      });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('***'),
      });
      expect(task.containers[0]!.command).toEqual(['--bucket', '']);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        /Command\[1\]: resolved a cross-stack value recorded as the secret mask/
      );
    });

    it('argvValue refuses a value that is the secret mask on its own (go-to-k/cdkd#6270)', () => {
      expect(argvValue('***')).toEqual({
        reason: 'resolved to the secret mask (***), not the deployed value',
      });
      expect(argvValue('a***b')).toEqual({ value: 'a***b' });
    });

    it('refuses a producer mask joined into a longer element (go-to-k/cdkd#6270)', async () => {
      const element = { 'Fn::Join': ['', ['--token=', { 'Fn::ImportValue': 'P-Tok' }]] };
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['run', element] })], {
        stateResources: {},
      });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('***'),
      });
      expect(task.containers[0]!.command).toEqual(['run', '']);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        /Command\[1\]: resolved a cross-stack value recorded as the secret mask/
      );
    });

    describe('an attribute read whose target a cross-stack value names (go-to-k/cdkd#6270)', () => {
      const state: Record<string, ResourceState> = {
        Key: {
          physicalId: 'AKIAEXAMPLE',
          resourceType: 'AWS::IAM::AccessKey',
          properties: {},
          attributes: { SecretAccessKey: 'plaintext-secret-key' },
          dependencies: [],
        },
      };
      it.each([
        ['a Fn::GetAtt logical ID', { 'Fn::GetAtt': [{ 'Fn::ImportValue': 'X' }, 'SecretAccessKey'] }, 'Key', /Fn::GetAtt whose logical ID/],
        ['a dotted Fn::GetAtt', { 'Fn::GetAtt': { 'Fn::ImportValue': 'X' } }, 'Key.SecretAccessKey', /Fn::GetAtt whose logical ID/],
        ['a Fn::Sub template', { 'Fn::Sub': { 'Fn::ImportValue': 'X' } }, '${Key.SecretAccessKey}', /Fn::Sub whose template/],
        [
          'an array-form Fn::Sub template inside Fn::Join',
          { 'Fn::Join': ['', ['k=', { 'Fn::Sub': [{ 'Fn::ImportValue': 'X' }, {}] }]] },
          '${Key.SecretAccessKey}',
          /Fn::Sub whose template/,
        ],
      ])('refuses %s', async (_label, element, exported, reason) => {
        const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['run', element] })], {
          stateResources: state,
        });
        await applyCrossStackResolverToTask(task, {
          resources: state,
          crossStackResolver: resolver(exported),
        });
        expect(JSON.stringify(task.containers[0])).not.toMatch(/plaintext/);
        expect(() => assertEcsTaskCommandsResolved(task)).toThrow(reason);
      });
    });

    it('resolves an Environment value with a nested Fn::ImportValue (go-to-k/cdkd#6270)', async () => {
      const stack = buildStack({
        Environment: [
          { Name: 'URI', Value: { 'Fn::Join': ['', ['s3://', { 'Fn::ImportValue': 'Producer-Bucket' }]] } },
        ],
      });
      expect(detectEcsImageResolutionNeeds(stack).needsCrossStackResolver).toBe(true);
      const task = resolveEcsTaskTarget('TD', [stack], { stateResources: {} });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('producer-bucket'),
      });
      expect(task.containers[0]!.environment['URI']).toBe('s3://producer-bucket');
    });

    it('names a cross-stack reference when no post-pass ran', () => {
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })]);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        /Command\[1\]: a cross-stack reference \(Fn::ImportValue/
      );
    });

    it('patches EntryPoint and HealthCheck.Command elements too', async () => {
      const stack = buildStack({
        EntryPoint: ['sh', { 'Fn::ImportValue': 'Producer-Bucket' }],
        HealthCheck: { Command: ['CMD', { 'Fn::ImportValue': 'Producer-Bucket' }] },
      });
      const task = resolveEcsTaskTarget('TD', [stack], { stateResources: {} });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('producer-bucket'),
      });
      expect(task.containers[0]!.entryPoint).toEqual(['sh', 'producer-bucket']);
      expect(task.containers[0]!.healthCheck?.command).toEqual(['CMD', 'producer-bucket']);
      expect(task.containers[0]!.unresolvedCommandElements).toBeUndefined();
    });

    it("replaces the sync pass's reason with the post-pass's own when the producer output is missing", async () => {
      // No state record for the consumer stack: the sync pass had no context.
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })]);
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver(undefined),
      });
      const [u] = task.containers[0]!.unresolvedCommandElements!;
      expect(u!.reason).toMatch(/Producer-Bucket/);
      expect(u!.reason).not.toMatch(/a cross-stack reference|--from-state/);
    });

    it('still refuses when the producer output is missing', async () => {
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })], {
        stateResources: {},
      });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver(undefined),
      });
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(/Container 'cli' Command\[1\]/);
    });

    it('refuses a producer output that is a dynamic reference rather than put it on the argv', async () => {
      const hook = vi.fn().mockResolvedValue('plaintext');
      const task = resolveEcsTaskTarget('TD', [buildStack({ Command: importCommand })], {
        stateResources: {},
      });
      await applyCrossStackResolverToTask(task, {
        resources: {},
        crossStackResolver: resolver('{{resolve:secretsmanager:s:SecretString}}'),
        resolveDynamicReferences: hook,
      });
      expect(hook).not.toHaveBeenCalled();
      expect(task.containers[0]!.command).toEqual(['--bucket', '']);
      expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
        /Container 'cli' Command\[1\]: resolved to a CloudFormation dynamic reference.*Environment variable or a Secrets entry/
      );
    });
  });
});

describe("a producer stack's secret read across stacks (go-to-k/cdkd#6337)", () => {
  const plaintext = 'da2-plaintextproducerkey';
  /** The producer's state: an exported AppSync ApiKey, its key in the id. */
  const producerState = {
    resources: {
      ApiKey: {
        physicalId: `apiid123|${plaintext}`,
        resourceType: 'AWS::AppSync::ApiKey',
        properties: {},
        attributes: { ApiKey: plaintext },
        dependencies: [],
      },
      Db: {
        physicalId: 'db',
        resourceType: 'Custom::Database',
        properties: {},
        // A 10-character secret under a secret-like name, beside short
        // ordinary values under such names.
        attributes: { DbPassword: 'pw10charsX', PasswordPolicy: 'strict', SecretEnabled: 'true' },
        dependencies: [],
      },
    },
    outputs: {
      Key: plaintext,
      KeyArn: `arn:aws:appsync:us-east-1:123456789012:apis/apiid123/apikeys/${plaintext}`,
      Bucket: 'producer-bucket',
      Pw: 'pw10charsX',
      Mode: 'strict',
      Flag: 'true',
      Url: 'postgres://u:pw10charsX@db.example',
    },
  };
  /**
   * A cdkd-built resolver's shape: the judged variants beside the contract,
   * each judging the value against the producer state with the real reader.
   * `unreadable` names a value the producer state could not vouch for.
   */
  function producerResolver(unreadable?: string): CrossStackResolver {
    const reader = new ProducerSecretReader(
      async () => null,
      () => undefined
    );
    const judged = async (name: string): Promise<JudgedValue> => {
      const value = (producerState.outputs as Record<string, string>)[name];
      if (value === undefined) return { value };
      if (value === unreadable) return { value, verdict: 'unreadable' };
      const verdict = await reader.judge('Producer', 'us-east-1', producerState, value);
      return verdict === undefined ? { value } : { value, verdict };
    };
    const importName = (exportName: string): string => exportName.replace(/^Producer-/, '');
    return {
      resolveImportJudged: (exportName: string) => judged(importName(exportName)),
      resolveGetStackOutputJudged: (_stack: string, _region: string, output: string) =>
        judged(output),
      resolveImport: async (exportName: string) =>
        (await judged(importName(exportName))).value,
      resolveGetStackOutput: async (_stack: string, _region: string, output: string) =>
        (await judged(output)).value,
    } as CrossStackResolver;
  }

  it.each([
    ['Fn::ImportValue', { 'Fn::ImportValue': 'Producer-Key' }],
    ['Fn::GetStackOutput', { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'Key' } }],
    ['a Fn::Join of Fn::ImportValue', { 'Fn::Join': ['', ['--key=', { 'Fn::ImportValue': 'Producer-Key' }]] }],
    ['an export holding the key inside a longer value (its ARN)', { 'Fn::ImportValue': 'Producer-KeyArn' }],
  ])('refuses %s of a producer secret on the Command argv', async (_label, element) => {
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['run', element] })], {
      stateResources: {},
    });
    await applyCrossStackResolverToTask(task, {
      resources: {},
      consumerRegion: 'us-east-1',
      crossStackResolver: producerResolver(),
    });
    expect(dockerArgs(task).join(' ')).not.toContain(plaintext);
    expect(JSON.stringify(task.containers[0])).not.toContain(plaintext);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
      /Command\[1\]: resolved a cross-stack value holding a secret of the producer stack/
    );
  });

  it('refuses it on EntryPoint and HealthCheck.Command too', async () => {
    const stack = buildStack({
      EntryPoint: ['sh', { 'Fn::ImportValue': 'Producer-Key' }],
      HealthCheck: { Command: ['CMD', { 'Fn::ImportValue': 'Producer-Key' }] },
    });
    const task = resolveEcsTaskTarget('TD', [stack], { stateResources: {} });
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver(),
    });
    expect(dockerArgs(task).join(' ')).not.toContain(plaintext);
    expect(task.containers[0]!.unresolvedCommandElements?.map((u) => u.field)).toEqual([
      'EntryPoint',
      'HealthCheck.Command',
    ]);
  });

  it("still puts the same producer's non-secret export on the argv", async () => {
    const task = resolveEcsTaskTarget(
      'TD',
      [buildStack({ Command: ['--bucket', { 'Fn::ImportValue': 'Producer-Bucket' }] })],
      { stateResources: {} }
    );
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver(),
    });
    expect(dockerArgs(task)).toContain('producer-bucket');
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('serves it in Environment value-less, off the argv, and a non-secret one inline', async () => {
    const stack = buildStack({
      Environment: [
        { Name: 'API_KEY', Value: { 'Fn::ImportValue': 'Producer-Key' } },
        { Name: 'BUCKET', Value: { 'Fn::ImportValue': 'Producer-Bucket' } },
      ],
    });
    const task = resolveEcsTaskTarget('TD', [stack], { stateResources: {} });
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver(),
    });
    // CloudFormation accepts a secret export in Environment: it still resolves.
    expect(task.containers[0]!.environment['API_KEY']).toBe(plaintext);
    expect(task.containers[0]!.resolvedDynamicReferenceKeys).toEqual(['API_KEY']);
    const args = dockerArgs(task);
    expect(args.join(' ')).not.toContain(plaintext);
    expect(envFlags(args)).toContain('API_KEY');
    expect(envFlags(args)).toContain('BUCKET=producer-bucket');
  });

  it('drops a Secrets ValueFrom that resolves to a producer secret, naming no value', async () => {
    const stack = buildStack({
      Secrets: [{ Name: 'TOKEN', ValueFrom: { 'Fn::ImportValue': 'Producer-Key' } }],
    });
    const task = resolveEcsTaskTarget('TD', [stack], { stateResources: {} });
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver(),
    });
    expect(task.containers[0]!.secrets).toEqual([]);
    expect(task.containers[0]!.droppedSecretNames).toEqual(['TOKEN']);
    expect(JSON.stringify(task)).not.toContain(plaintext);
    expect(task.containers[0]!.warnings).toContainEqual(
      expect.stringMatching(/^Secret 'TOKEN' dropped: ValueFrom resolved a cross-stack value holding a secret/)
    );
    expect(task.warnings).toContainEqual(
      expect.stringMatching(/^Container 'cli': Secret 'TOKEN' dropped: ValueFrom resolved a cross-stack/)
    );
  });

  it('refuses on the argv, and drops as a ValueFrom, a value whose producer state was unreadable', async () => {
    const stack = buildStack({
      Command: ['--bucket', { 'Fn::ImportValue': 'Producer-Bucket' }],
      Secrets: [{ Name: 'TOKEN', ValueFrom: { 'Fn::ImportValue': 'Producer-Bucket' } }],
    });
    const task = resolveEcsTaskTarget('TD', [stack], { stateResources: {} });
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver('producer-bucket'),
    });
    expect(dockerArgs(task)).not.toContain('producer-bucket');
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
      /Command\[1\]: resolved a cross-stack value whose producer stack's state cdkd could not read/
    );
    expect(task.containers[0]!.secrets).toEqual([]);
    expect(task.containers[0]!.warnings).toContainEqual(
      expect.stringMatching(/^Secret 'TOKEN' dropped: ValueFrom resolved a cross-stack value whose producer stack's state cdkd could not read/)
    );
  });

  it.each([
    ['secret first', ['Producer-Key', 'Producer-Bucket']],
    ['secret second', ['Producer-Bucket', 'Producer-Key']],
  ])('refuses one element reading a secret and a non-secret import (%s)', async (_l, names) => {
    const element = {
      'Fn::Join': [':', names.map((n) => ({ 'Fn::ImportValue': n }))],
    };
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['run', element] })], {
      stateResources: {},
    });
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver(),
    });
    expect(dockerArgs(task).join(' ')).not.toContain(plaintext);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
      /Command\[1\]: resolved a cross-stack value holding a secret of the producer stack/
    );
  });

  it.each([
    ['secret first', ['Producer-Key', 'Producer-Bucket']],
    ['secret second', ['Producer-Bucket', 'Producer-Key']],
  ])('names the secret over an unreadable value in one element (%s)', async (_l, names) => {
    const element = {
      'Fn::Join': [':', names.map((n) => ({ 'Fn::ImportValue': n }))],
    };
    const task = resolveEcsTaskTarget('TD', [buildStack({ Command: ['run', element] })], {
      stateResources: {},
    });
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver('producer-bucket'),
    });
    expect(dockerArgs(task).join(' ')).not.toContain(plaintext);
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
      /Command\[1\]: resolved a cross-stack value holding a secret of the producer stack/
    );
  });

  it('serves an unreadable value in Environment value-less', async () => {
    const stack = buildStack({
      Environment: [{ Name: 'BUCKET', Value: { 'Fn::ImportValue': 'Producer-Bucket' } }],
    });
    const task = resolveEcsTaskTarget('TD', [stack], { stateResources: {} });
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver('producer-bucket'),
    });
    expect(task.containers[0]!.environment['BUCKET']).toBe('producer-bucket');
    expect(task.containers[0]!.resolvedDynamicReferenceKeys).toEqual(['BUCKET']);
    const args = dockerArgs(task);
    expect(args).not.toContain('BUCKET=producer-bucket');
    expect(envFlags(args)).toContain('BUCKET');
  });

  it('refuses a 10-character secret-named value exported whole', async () => {
    const task = resolveEcsTaskTarget(
      'TD',
      [buildStack({ Command: ['--pw', { 'Fn::ImportValue': 'Producer-Pw' }] })],
      { stateResources: {} }
    );
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver(),
    });
    expect(dockerArgs(task).join(' ')).not.toContain('pw10charsX');
    expect(() => assertEcsTaskCommandsResolved(task)).toThrow(
      /Command\[1\]: resolved a cross-stack value holding a secret of the producer stack/
    );
  });

  it.each([
    ['a short value under a secret-like name (strict)', 'Producer-Mode', 'strict'],
    ['a short value under a secret-like name (true)', 'Producer-Flag', 'true'],
    [
      'a longer export holding a 10-character secret-named value',
      'Producer-Url',
      'postgres://u:pw10charsX@db.example',
    ],
  ])('still resolves %s onto the argv', async (_l, exportName, value) => {
    const task = resolveEcsTaskTarget(
      'TD',
      [buildStack({ Command: ['--v', { 'Fn::ImportValue': exportName }] })],
      { stateResources: {} }
    );
    await applyCrossStackResolverToTask(task, {
      resources: {},
      crossStackResolver: producerResolver(),
    });
    expect(dockerArgs(task)).toContain(value);
    expect(() => assertEcsTaskCommandsResolved(task)).not.toThrow();
  });

  it('a resolver without the check is not judged (the --from-cfn-stack one)', async () => {
    const plain: CrossStackResolver = {
      resolveImport: vi.fn().mockResolvedValue('not-judged-value'),
      resolveGetStackOutput: vi.fn().mockResolvedValue(undefined),
    };
    const task = resolveEcsTaskTarget(
      'TD',
      [buildStack({ Command: ['run', { 'Fn::ImportValue': 'X' }] })],
      { stateResources: {} }
    );
    await applyCrossStackResolverToTask(task, { resources: {}, crossStackResolver: plain });
    expect(task.containers[0]!.command).toEqual(['run', 'not-judged-value']);
  });
});
