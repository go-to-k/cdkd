import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `vi.hoisted` because both spies are referenced from the `vi.mock` factories
// below, which are hoisted above ordinary top-level declarations.
const { mockSend, warnSpy, mockGetCreateOnly } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  mockGetCreateOnly: vi.fn(),
}));

vi.mock('@aws-sdk/client-ecs', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-ecs')>('@aws-sdk/client-ecs');
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

// Only the DescribeType-backed path lookup is mocked; the pure
// `createOnlyChangeRequiresReplacement` comparison runs for real so the Role
// replacement classification is exercised through the real diff machinery.
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return {
    ...actual,
    getCreateOnlyPropertyPaths: (resourceType: string) => mockGetCreateOnly(resourceType),
  };
});

import { CreateServiceCommand, UpdateServiceCommand } from '@aws-sdk/client-ecs';
import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::ECS::Service';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCHEMA_FIXTURE_PATH = join(
  __dirname,
  '..',
  '..',
  'fixtures',
  'cfn-schemas',
  'AWS-ECS-Service.json'
);

const SERVICE_ARN = 'arn:aws:ecs:us-east-1:123456789012:service/my-cluster/my-service';

const createResponse = {
  service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
};
const updateResponse = {
  service: { serviceArn: SERVICE_ARN, serviceName: 'my-service' },
};

/** Baseline properties shared by the update-path tests. */
const baseProps = (): Record<string, unknown> => ({
  Cluster: 'my-cluster',
  TaskDefinition: 'my-task:1',
  DesiredCount: 0,
});

const findCommand = (ctor: unknown) =>
  mockSend.mock.calls.find((c) => c[0] instanceof (ctor as new (...args: never[]) => object))?.[0];

/**
 * Issue #609 backfill: the `AWS::ECS::Service` properties cdkd used to
 * silently drop on write — AvailabilityZoneRebalancing, DeploymentController,
 * ForceNewDeployment, Monitoring, Role, ServiceConnectConfiguration,
 * VolumeConfigurations, VpcLatticeConfigurations.
 *
 * The failure these tests exist for is NOT a crash — the AWS SDK v3
 * serializer drops members it does not know, so a near-miss spelling
 * (`managedEbsVolume` for `managedEBSVolume`, `sizeInGib` for `sizeInGiB`)
 * deploys "successfully" with the config missing. Every assertion below
 * therefore pins the EXACT SDK member name rather than "some config was
 * sent".
 */
describe('ECS Service config properties (#609)', () => {
  let provider: ECSProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    mockGetCreateOnly.mockReset();
    mockGetCreateOnly.mockResolvedValue([]);
    provider = new ECSProvider();
  });

  describe('create', () => {
    it('wires every new member onto CreateService with the exact SDK spellings', async () => {
      mockSend.mockResolvedValueOnce(createResponse);

      await provider.create('Svc', TYPE, {
        ...baseProps(),
        ServiceName: 'my-service',
        AvailabilityZoneRebalancing: 'ENABLED',
        DeploymentController: { Type: 'ECS' },
        Role: 'arn:aws:iam::123456789012:role/my-classic-elb-role',
        ServiceConnectConfiguration: {
          Enabled: true,
          Namespace: 'my-namespace',
          Services: [
            {
              PortName: 'http',
              DiscoveryName: 'web',
              IngressPortOverride: 8081,
              ClientAliases: [{ Port: 80, DnsName: 'web.local' }],
              Timeout: { IdleTimeoutSeconds: 60, PerRequestTimeoutSeconds: 30 },
              Tls: {
                IssuerCertificateAuthority: {
                  AwsPcaAuthorityArn: 'arn:aws:acm-pca:us-east-1:1:certificate-authority/x',
                },
                KmsKey: 'arn:aws:kms:us-east-1:1:key/k',
                RoleArn: 'arn:aws:iam::1:role/tls',
              },
            },
          ],
          LogConfiguration: {
            LogDriver: 'awslogs',
            // Free-form log-driver option keys are USER DATA — the
            // uppercase-starting key pins that they are copied verbatim,
            // never first-letter-flipped.
            Options: { 'awslogs-group': '/ecs/svc', 'Custom-Opt': 'Value' },
            SecretOptions: [{ Name: 'token', ValueFrom: 'arn:aws:ssm:us-east-1:1:parameter/p' }],
          },
          AccessLogConfiguration: { Format: 'JSON', IncludeQueryParameters: 'ENABLED' },
        },
        VolumeConfigurations: [
          {
            Name: 'ebs-data',
            ManagedEBSVolume: {
              Encrypted: true,
              KmsKeyId: 'arn:aws:kms:us-east-1:1:key/k',
              VolumeType: 'gp3',
              SizeInGiB: 10,
              SnapshotId: 'snap-123',
              VolumeInitializationRate: 100,
              Iops: 3000,
              Throughput: 125,
              RoleArn: 'arn:aws:iam::1:role/ebs',
              FilesystemType: 'xfs',
              TagSpecifications: [
                {
                  ResourceType: 'volume',
                  PropagateTags: 'SERVICE',
                  Tags: [{ Key: 'env', Value: 'test' }],
                },
              ],
            },
          },
        ],
        VpcLatticeConfigurations: [
          {
            RoleArn: 'arn:aws:iam::1:role/lattice',
            TargetGroupArn: 'arn:aws:vpc-lattice:us-east-1:1:targetgroup/tg-1',
            PortName: 'http',
          },
        ],
        Monitoring: {
          MetricConfigurations: [
            { MetricNames: ['CPUUtilization', 'MemoryUtilization'], ResolutionSeconds: 60 },
          ],
        },
      });

      const cmd = findCommand(CreateServiceCommand);
      expect(cmd).toBeDefined();
      expect(cmd.input).toMatchObject({
        availabilityZoneRebalancing: 'ENABLED',
        deploymentController: { type: 'ECS' },
        role: 'arn:aws:iam::123456789012:role/my-classic-elb-role',
        serviceConnectConfiguration: {
          enabled: true,
          namespace: 'my-namespace',
          services: [
            {
              portName: 'http',
              discoveryName: 'web',
              ingressPortOverride: 8081,
              clientAliases: [{ port: 80, dnsName: 'web.local' }],
              timeout: { idleTimeoutSeconds: 60, perRequestTimeoutSeconds: 30 },
              tls: {
                issuerCertificateAuthority: {
                  awsPcaAuthorityArn: 'arn:aws:acm-pca:us-east-1:1:certificate-authority/x',
                },
                kmsKey: 'arn:aws:kms:us-east-1:1:key/k',
                roleArn: 'arn:aws:iam::1:role/tls',
              },
            },
          ],
          logConfiguration: {
            logDriver: 'awslogs',
            options: { 'awslogs-group': '/ecs/svc', 'Custom-Opt': 'Value' },
            secretOptions: [{ name: 'token', valueFrom: 'arn:aws:ssm:us-east-1:1:parameter/p' }],
          },
          accessLogConfiguration: { format: 'JSON', includeQueryParameters: 'ENABLED' },
        },
        // `managedEBSVolume` / `sizeInGiB` are the two spellings a sloppy
        // conversion gets wrong (`managedEbsVolume` / `sizeInGib`); the
        // serializer would drop them silently.
        volumeConfigurations: [
          {
            name: 'ebs-data',
            managedEBSVolume: {
              encrypted: true,
              kmsKeyId: 'arn:aws:kms:us-east-1:1:key/k',
              volumeType: 'gp3',
              sizeInGiB: 10,
              snapshotId: 'snap-123',
              volumeInitializationRate: 100,
              iops: 3000,
              throughput: 125,
              roleArn: 'arn:aws:iam::1:role/ebs',
              filesystemType: 'xfs',
              tagSpecifications: [
                {
                  resourceType: 'volume',
                  propagateTags: 'SERVICE',
                  tags: [{ key: 'env', value: 'test' }],
                },
              ],
            },
          },
        ],
        vpcLatticeConfigurations: [
          {
            roleArn: 'arn:aws:iam::1:role/lattice',
            targetGroupArn: 'arn:aws:vpc-lattice:us-east-1:1:targetgroup/tg-1',
            portName: 'http',
          },
        ],
        monitoring: {
          metricConfigurations: [
            { metricNames: ['CPUUtilization', 'MemoryUtilization'], resolutionSeconds: 60 },
          ],
        },
      });
      // The exact camelCase keys must be present — `toMatchObject` above
      // would pass on a PascalCase sibling key sitting next to a missing one.
      expect(Object.keys(cmd.input)).toEqual(
        expect.arrayContaining([
          'availabilityZoneRebalancing',
          'deploymentController',
          'role',
          'serviceConnectConfiguration',
          'volumeConfigurations',
          'vpcLatticeConfigurations',
          'monitoring',
        ])
      );
      expect(Object.keys(cmd.input.volumeConfigurations[0])).toContain('managedEBSVolume');
      expect(Object.keys(cmd.input.volumeConfigurations[0].managedEBSVolume)).toContain('sizeInGiB');
    });

    it('ForceNewDeployment is a create-path no-op (CreateService has no such member)', async () => {
      mockSend.mockResolvedValueOnce(createResponse);

      await provider.create('Svc', TYPE, {
        ...baseProps(),
        ServiceName: 'my-service',
        ForceNewDeployment: { EnableForceNewDeployment: true, ForceNewDeploymentNonce: 'n-1' },
      });

      const cmd = findCommand(CreateServiceCommand);
      expect(cmd).toBeDefined();
      expect(cmd.input.forceNewDeployment).toBeUndefined();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('omits every new member when the template does not set it', async () => {
      mockSend.mockResolvedValueOnce(createResponse);

      await provider.create('Svc', TYPE, { ...baseProps(), ServiceName: 'my-service' });

      const cmd = findCommand(CreateServiceCommand);
      expect(cmd.input.availabilityZoneRebalancing).toBeUndefined();
      expect(cmd.input.deploymentController).toBeUndefined();
      expect(cmd.input.role).toBeUndefined();
      expect(cmd.input.serviceConnectConfiguration).toBeUndefined();
      expect(cmd.input.volumeConfigurations).toBeUndefined();
      expect(cmd.input.vpcLatticeConfigurations).toBeUndefined();
      expect(cmd.input.monitoring).toBeUndefined();
    });
  });

  describe('update change detection (both polarities per member)', () => {
    const update = (
      props: Record<string, unknown>,
      prev: Record<string, unknown>
    ): Promise<unknown> => {
      mockSend.mockResolvedValueOnce(updateResponse);
      return provider.update('Svc', SERVICE_ARN, TYPE, props, prev);
    };

    it('AvailabilityZoneRebalancing: change is sent; unchanged is NOT sent', async () => {
      await update(
        { ...baseProps(), AvailabilityZoneRebalancing: 'ENABLED' },
        { ...baseProps(), AvailabilityZoneRebalancing: 'DISABLED' }
      );
      expect(findCommand(UpdateServiceCommand).input.availabilityZoneRebalancing).toBe('ENABLED');

      mockSend.mockReset();
      await update(
        { ...baseProps(), AvailabilityZoneRebalancing: 'ENABLED' },
        { ...baseProps(), AvailabilityZoneRebalancing: 'ENABLED' }
      );
      expect(
        findCommand(UpdateServiceCommand).input.availabilityZoneRebalancing
      ).toBeUndefined();
    });

    it('AvailabilityZoneRebalancing: removal is DEFERRED (nothing sent — AWS keeps the live value)', async () => {
      await update(baseProps(), { ...baseProps(), AvailabilityZoneRebalancing: 'ENABLED' });
      expect(
        findCommand(UpdateServiceCommand).input.availabilityZoneRebalancing
      ).toBeUndefined();
    });

    it('DeploymentController: change is sent as {type}; unchanged / removal are NOT sent', async () => {
      await update(
        { ...baseProps(), DeploymentController: { Type: 'CODE_DEPLOY' } },
        { ...baseProps(), DeploymentController: { Type: 'ECS' } }
      );
      expect(findCommand(UpdateServiceCommand).input.deploymentController).toEqual({
        type: 'CODE_DEPLOY',
      });

      mockSend.mockReset();
      await update(
        { ...baseProps(), DeploymentController: { Type: 'ECS' } },
        { ...baseProps(), DeploymentController: { Type: 'ECS' } }
      );
      expect(findCommand(UpdateServiceCommand).input.deploymentController).toBeUndefined();

      // Removal: absent means the default ECS controller; nothing is sent.
      mockSend.mockReset();
      await update(baseProps(), { ...baseProps(), DeploymentController: { Type: 'ECS' } });
      expect(findCommand(UpdateServiceCommand).input.deploymentController).toBeUndefined();
    });

    it('ServiceConnectConfiguration: change is sent converted; unchanged is NOT sent', async () => {
      const scc = { Enabled: true, Namespace: 'ns', Services: [{ PortName: 'http' }] };
      await update({ ...baseProps(), ServiceConnectConfiguration: scc }, baseProps());
      expect(findCommand(UpdateServiceCommand).input.serviceConnectConfiguration).toEqual({
        enabled: true,
        namespace: 'ns',
        services: [{ portName: 'http' }],
      });

      mockSend.mockReset();
      await update(
        { ...baseProps(), ServiceConnectConfiguration: scc },
        { ...baseProps(), ServiceConnectConfiguration: scc }
      );
      expect(
        findCommand(UpdateServiceCommand).input.serviceConnectConfiguration
      ).toBeUndefined();
    });

    it('ServiceConnectConfiguration: removal resets to the documented disable shape {enabled: false}', async () => {
      await update(baseProps(), {
        ...baseProps(),
        ServiceConnectConfiguration: { Enabled: true, Namespace: 'ns' },
      });
      expect(findCommand(UpdateServiceCommand).input.serviceConnectConfiguration).toEqual({
        enabled: false,
      });
    });

    it('VolumeConfigurations: change is sent converted; unchanged is NOT sent; removal resets to []', async () => {
      const vc = [{ Name: 'ebs-data', ManagedEBSVolume: { SizeInGiB: 10, VolumeType: 'gp3' } }];
      await update({ ...baseProps(), VolumeConfigurations: vc }, baseProps());
      expect(findCommand(UpdateServiceCommand).input.volumeConfigurations).toEqual([
        { name: 'ebs-data', managedEBSVolume: { sizeInGiB: 10, volumeType: 'gp3' } },
      ]);

      mockSend.mockReset();
      await update(
        { ...baseProps(), VolumeConfigurations: vc },
        { ...baseProps(), VolumeConfigurations: vc }
      );
      expect(findCommand(UpdateServiceCommand).input.volumeConfigurations).toBeUndefined();

      mockSend.mockReset();
      await update(baseProps(), { ...baseProps(), VolumeConfigurations: vc });
      expect(findCommand(UpdateServiceCommand).input.volumeConfigurations).toEqual([]);
    });

    it('VpcLatticeConfigurations: change is sent converted; unchanged is NOT sent; removal resets to []', async () => {
      const vlc = [
        {
          RoleArn: 'arn:aws:iam::1:role/lattice',
          TargetGroupArn: 'arn:aws:vpc-lattice:us-east-1:1:targetgroup/tg-1',
          PortName: 'http',
        },
      ];
      await update({ ...baseProps(), VpcLatticeConfigurations: vlc }, baseProps());
      expect(findCommand(UpdateServiceCommand).input.vpcLatticeConfigurations).toEqual([
        {
          roleArn: 'arn:aws:iam::1:role/lattice',
          targetGroupArn: 'arn:aws:vpc-lattice:us-east-1:1:targetgroup/tg-1',
          portName: 'http',
        },
      ]);

      mockSend.mockReset();
      await update(
        { ...baseProps(), VpcLatticeConfigurations: vlc },
        { ...baseProps(), VpcLatticeConfigurations: vlc }
      );
      expect(findCommand(UpdateServiceCommand).input.vpcLatticeConfigurations).toBeUndefined();

      mockSend.mockReset();
      await update(baseProps(), { ...baseProps(), VpcLatticeConfigurations: vlc });
      expect(findCommand(UpdateServiceCommand).input.vpcLatticeConfigurations).toEqual([]);
    });

    it('Monitoring: change is sent converted; unchanged is NOT sent; removal is DEFERRED (nothing sent)', async () => {
      const mon = { MetricConfigurations: [{ MetricNames: ['CPUUtilization'], ResolutionSeconds: 20 }] };
      await update({ ...baseProps(), Monitoring: mon }, baseProps());
      expect(findCommand(UpdateServiceCommand).input.monitoring).toEqual({
        metricConfigurations: [{ metricNames: ['CPUUtilization'], resolutionSeconds: 20 }],
      });

      mockSend.mockReset();
      await update({ ...baseProps(), Monitoring: mon }, { ...baseProps(), Monitoring: mon });
      expect(findCommand(UpdateServiceCommand).input.monitoring).toBeUndefined();

      mockSend.mockReset();
      await update(baseProps(), { ...baseProps(), Monitoring: mon });
      expect(findCommand(UpdateServiceCommand).input.monitoring).toBeUndefined();
    });
  });

  describe('ForceNewDeployment object -> boolean translation on update', () => {
    const update = (
      props: Record<string, unknown>,
      prev: Record<string, unknown>
    ): Promise<unknown> => {
      mockSend.mockResolvedValueOnce(updateResponse);
      return provider.update('Svc', SERVICE_ARN, TYPE, props, prev);
    };

    it('EnableForceNewDeployment: true forces a rollout', async () => {
      await update(
        { ...baseProps(), ForceNewDeployment: { EnableForceNewDeployment: true } },
        { ...baseProps(), ForceNewDeployment: { EnableForceNewDeployment: true } }
      );
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBe(true);
    });

    it('a ForceNewDeploymentNonce change forces a rollout', async () => {
      await update(
        { ...baseProps(), ForceNewDeployment: { ForceNewDeploymentNonce: 'n-2' } },
        { ...baseProps(), ForceNewDeployment: { ForceNewDeploymentNonce: 'n-1' } }
      );
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBe(true);
    });

    it('introducing a nonce (no previous block) forces a rollout', async () => {
      await update(
        { ...baseProps(), ForceNewDeployment: { ForceNewDeploymentNonce: 'n-1' } },
        baseProps()
      );
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBe(true);
    });

    it('an unchanged nonce with EnableForceNewDeployment false does NOT force', async () => {
      await update(
        {
          ...baseProps(),
          DesiredCount: 1,
          ForceNewDeployment: { EnableForceNewDeployment: false, ForceNewDeploymentNonce: 'n-1' },
        },
        { ...baseProps(), ForceNewDeployment: { EnableForceNewDeployment: false, ForceNewDeploymentNonce: 'n-1' } }
      );
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBeUndefined();
    });

    it('an absent block does NOT force (field omitted, AWS default)', async () => {
      await update({ ...baseProps(), DesiredCount: 1 }, baseProps());
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBeUndefined();
    });

    it('a malformed (non-object) block warns and skips instead of throwing (update-path doctrine)', async () => {
      await update({ ...baseProps(), ForceNewDeployment: 'true' }, baseProps());
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ForceNewDeployment'));
    });

    it('a malformed ARRAY block warns and skips (the Array.isArray half of the guard)', async () => {
      await update({ ...baseProps(), ForceNewDeployment: ['n-1'] }, baseProps());
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('array'));
    });

    it('removing the block (present before, absent now) does NOT force a rollout', async () => {
      await update(
        { ...baseProps(), DesiredCount: 1 },
        { ...baseProps(), ForceNewDeployment: { EnableForceNewDeployment: true, ForceNewDeploymentNonce: 'n-1' } }
      );
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBeUndefined();
    });

    it("EnableForceNewDeployment: 'true' (CFn string boolean) forces a rollout via coerceBool", async () => {
      await update(
        { ...baseProps(), ForceNewDeployment: { EnableForceNewDeployment: 'true' } },
        baseProps()
      );
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBe(true);
    });

    it('a value-equal non-primitive nonce does NOT force (value compare, not identity)', async () => {
      // Regression pin for the review catch: an identity compare read a
      // fresh-but-equal object nonce as "changed" on every deploy.
      await update(
        {
          ...baseProps(),
          DesiredCount: 1,
          ForceNewDeployment: { ForceNewDeploymentNonce: { Rev: 1 } },
        },
        { ...baseProps(), ForceNewDeployment: { ForceNewDeploymentNonce: { Rev: 1 } } }
      );
      expect(findCommand(UpdateServiceCommand).input.forceNewDeployment).toBeUndefined();
    });
  });

  describe('DeploymentController delivery keeps the LoadBalancers/ServiceRegistries gate intact', () => {
    it('still refuses a LoadBalancers change under the CODE_DEPLOY controller', async () => {
      await expect(
        provider.update(
          'Svc',
          SERVICE_ARN,
          TYPE,
          {
            ...baseProps(),
            DeploymentController: { Type: 'CODE_DEPLOY' },
            LoadBalancers: [{ TargetGroupArn: 'arn:tg-new', ContainerName: 'web', ContainerPort: 80 }],
          },
          {
            ...baseProps(),
            DeploymentController: { Type: 'CODE_DEPLOY' },
            LoadBalancers: [{ TargetGroupArn: 'arn:tg-old', ContainerName: 'web', ContainerPort: 80 }],
          }
        )
      ).rejects.toThrow(ProvisioningError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('delivers a controller change while the gate stays quiet without LB/registry changes', async () => {
      mockSend.mockResolvedValueOnce(updateResponse);
      await provider.update(
        'Svc',
        SERVICE_ARN,
        TYPE,
        { ...baseProps(), DeploymentController: { Type: 'ECS' } },
        { ...baseProps(), DeploymentController: { Type: 'CODE_DEPLOY' } }
      );
      const cmd = findCommand(UpdateServiceCommand);
      expect(cmd.input.deploymentController).toEqual({ type: 'ECS' });
    });
  });

  describe('Role (create-only)', () => {
    it('is passed through on create and never on update (UpdateService has no role member)', async () => {
      mockSend.mockResolvedValueOnce(createResponse);
      await provider.create('Svc', TYPE, {
        ...baseProps(),
        ServiceName: 'my-service',
        Role: 'my-role',
      });
      expect(findCommand(CreateServiceCommand).input.role).toBe('my-role');

      mockSend.mockReset();
      mockSend.mockResolvedValueOnce(updateResponse);
      await provider.update(
        'Svc',
        SERVICE_ARN,
        TYPE,
        { ...baseProps(), Role: 'my-role' },
        { ...baseProps(), Role: 'my-role' }
      );
      expect(findCommand(UpdateServiceCommand).input.role).toBeUndefined();
    });

    it('a Role change classifies as REPLACEMENT via the create-only schema fallback', async () => {
      // The registry schema fixture is the source of truth the runtime
      // DescribeType lookup mirrors — pin that Role really is createOnly
      // there, then feed those exact paths into the real DiffCalculator.
      const fixture = JSON.parse(readFileSync(SCHEMA_FIXTURE_PATH, 'utf8')) as {
        createOnlyProperties: string[];
      };
      expect(fixture.createOnlyProperties).toContain('Role');
      mockGetCreateOnly.mockResolvedValue(fixture.createOnlyProperties.map((p) => [p]));

      // No hand-authored replacement rule may shadow the fallback.
      const registry = new ReplacementRulesRegistry();
      expect(registry.isClassified(TYPE, 'Role')).toBe(false);

      const state: StackState = {
        version: 1,
        stackName: 'TestStack',
        resources: {
          Svc: {
            physicalId: SERVICE_ARN,
            resourceType: TYPE,
            properties: { ...baseProps(), Role: 'old-role' },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        lastModified: 0,
      };
      const template: CloudFormationTemplate = {
        Resources: {
          Svc: { Type: TYPE, Properties: { ...baseProps(), Role: 'new-role' } },
        },
      };

      const changes = await new DiffCalculator().calculateDiff(state, template);
      const change = changes.get('Svc');
      expect(change?.changeType).toBe('UPDATE');
      const pc = change?.propertyChanges?.find((c) => c.path === 'Role');
      expect(pc?.requiresReplacement).toBe(true);
    });
  });

  describe('declarations', () => {
    it('reports no silent-drop property left for the type', () => {
      const coverage = PROPERTY_COVERAGE_BY_TYPE.get(TYPE);
      expect([...(coverage?.silentDrop.keys() ?? [])]).toEqual([]);
      for (const property of [
        'AvailabilityZoneRebalancing',
        'DeploymentController',
        'ForceNewDeployment',
        'Monitoring',
        'Role',
        'ServiceConnectConfiguration',
        'VolumeConfigurations',
        'VpcLatticeConfigurations',
      ]) {
        expect(coverage?.handled.has(property), property).toBe(true);
      }
    });

    it('declares the unreadable members as drift-unknown paths (no phantom drift)', () => {
      expect(provider.getDriftUnknownPaths(TYPE).sort()).toEqual(
        [
          'ForceNewDeployment',
          'Monitoring',
          'Role',
          'ServiceConnectConfiguration',
          'VolumeConfigurations',
          'VpcLatticeConfigurations',
        ].sort()
      );
      expect(provider.getDriftUnknownPaths('AWS::ECS::Cluster')).toEqual([]);
    });
  });
});
