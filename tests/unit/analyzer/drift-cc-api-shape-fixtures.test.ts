import { describe, it, expect } from 'vite-plus/test';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { stripCcApiAwsManagedFields } from '../../../src/analyzer/cc-api-strip.js';
import { CC_API_FALLBACK_DENY_LIST } from '../../../src/analyzer/drift-cc-api-deny-list.js';

/**
 * Drift verification fixtures for resource types that go through the CC
 * API fallback (no SDK Provider `readCurrentState`).
 *
 * For each fixture:
 *
 *   - `state.properties` — what cdkd state stores (CFn template shape).
 *   - `awsResponse` — what `CloudControlClient.GetResource` returns,
 *     parsed from the `ResourceModel` JSON string.
 *
 * The pipeline mirrors `runDriftForStack` in `src/cli/commands/drift.ts`:
 *   1. CC API GetResource returns `awsResponse`.
 *   2. `stripCcApiAwsManagedFields(...)` removes AWS-managed noise.
 *   3. `calculateResourceDrift(state, stripped)` produces the drifts.
 *
 * Every fixture must produce **zero drifts** for an unmodified resource.
 * If a fixture fires drift, that's a shape mismatch — the type either
 * needs to be added to the deny-list or the strip helper needs an extra
 * field.
 *
 * Coverage is breadth-first across categories (networking, ML, storage,
 * security, observability, etc.). It is intentionally NOT exhaustive —
 * the goal is to catch shape regressions before users see them on a
 * specific type, and to give us a concrete example to check against
 * when CC API or the underlying SDK changes its response shape.
 *
 * Note: the `awsResponse` shapes are derived from AWS service
 * documentation as of the date this file was authored. CC API normalizes
 * SDK responses to the CFn schema for most resources, so these match the
 * CFn template shape with extra AWS-managed fields the strip pass
 * removes.
 */
interface ShapeFixture {
  name: string;
  resourceType: string;
  state: Record<string, unknown>;
  awsResponse: Record<string, unknown>;
}

const FIXTURES: ShapeFixture[] = [
  // ──────────────────────────────────────────────────────────────────
  // Networking
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::EC2::VPCEndpoint — gateway endpoint',
    resourceType: 'AWS::EC2::VPCEndpoint',
    state: {
      VpcId: 'vpc-0123abcd',
      ServiceName: 'com.amazonaws.us-east-1.s3',
      VpcEndpointType: 'Gateway',
      RouteTableIds: ['rtb-1', 'rtb-2'],
    },
    awsResponse: {
      VpcId: 'vpc-0123abcd',
      ServiceName: 'com.amazonaws.us-east-1.s3',
      VpcEndpointType: 'Gateway',
      RouteTableIds: ['rtb-1', 'rtb-2'],
      // AWS-managed extras stripped by cc-api-strip.
      State: 'available',
      CreationTime: '2024-01-15T10:30:00Z',
      OwnerId: '123456789012',
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // ML / AI
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::SageMaker::Endpoint',
    resourceType: 'AWS::SageMaker::Endpoint',
    state: {
      EndpointName: 'my-endpoint',
      EndpointConfigName: 'my-endpoint-config',
    },
    awsResponse: {
      EndpointName: 'my-endpoint',
      EndpointConfigName: 'my-endpoint-config',
      // Stripped by cc-api-strip.
      EndpointStatus: 'InService',
      CreationTime: '2024-01-01T00:00:00Z',
      LastModifiedTime: '2024-06-01T00:00:00Z',
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Storage / Backup
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::Backup::BackupVault',
    resourceType: 'AWS::Backup::BackupVault',
    state: {
      BackupVaultName: 'daily-backups',
      BackupVaultTags: { env: 'prod' },
    },
    awsResponse: {
      BackupVaultName: 'daily-backups',
      BackupVaultTags: { env: 'prod' },
      // Stripped.
      CreationDate: '2024-01-01T00:00:00Z',
      CreatedBy: 'arn:aws:iam::123456789012:user/admin',
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Security
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::SecurityHub::Hub',
    resourceType: 'AWS::SecurityHub::Hub',
    state: {
      AutoEnableControls: true,
      EnableDefaultStandards: false,
    },
    awsResponse: {
      AutoEnableControls: true,
      EnableDefaultStandards: false,
      // SubscribedAt and Arn are managed; the comparator ignores them
      // because state never set them — but our strip helper is the
      // belt-and-suspenders for cases where state DOES happen to carry
      // a stale value at the same path.
      SubscribedAt: '2024-01-01T00:00:00Z',
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Networking — security groups
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::EC2::SecurityGroup',
    resourceType: 'AWS::EC2::SecurityGroup',
    state: {
      GroupName: 'web-sg',
      GroupDescription: 'Allow HTTP/HTTPS',
      VpcId: 'vpc-0123abcd',
      SecurityGroupIngress: [
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
      ],
    },
    awsResponse: {
      GroupName: 'web-sg',
      GroupDescription: 'Allow HTTP/HTTPS',
      VpcId: 'vpc-0123abcd',
      SecurityGroupIngress: [
        { IpProtocol: 'tcp', FromPort: 80, ToPort: 80, CidrIp: '0.0.0.0/0' },
        { IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0' },
      ],
      // AWS-managed.
      OwnerId: '123456789012',
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Observability
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::CloudWatch::Dashboard',
    resourceType: 'AWS::CloudWatch::Dashboard',
    state: {
      DashboardName: 'main',
      DashboardBody: '{"widgets":[]}',
    },
    awsResponse: {
      DashboardName: 'main',
      DashboardBody: '{"widgets":[]}',
      // Stripped.
      LastModified: '2024-06-01T00:00:00Z',
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Messaging — SES (out of SDK provider scope)
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::SES::ConfigurationSet',
    resourceType: 'AWS::SES::ConfigurationSet',
    state: {
      Name: 'transactional',
      ReputationOptions: { ReputationMetricsEnabled: true },
    },
    awsResponse: {
      Name: 'transactional',
      ReputationOptions: {
        ReputationMetricsEnabled: true,
        // Nested timestamp — strip walks recursively.
        LastFreshStart: '2024-05-01T00:00:00Z',
      },
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // App services — AppRunner
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::AppRunner::Service',
    resourceType: 'AWS::AppRunner::Service',
    state: {
      ServiceName: 'my-service',
      SourceConfiguration: {
        AutoDeploymentsEnabled: true,
        ImageRepository: {
          ImageIdentifier: '123456789012.dkr.ecr.us-east-1.amazonaws.com/svc:latest',
          ImageRepositoryType: 'ECR',
        },
      },
    },
    awsResponse: {
      ServiceName: 'my-service',
      SourceConfiguration: {
        AutoDeploymentsEnabled: true,
        ImageRepository: {
          ImageIdentifier: '123456789012.dkr.ecr.us-east-1.amazonaws.com/svc:latest',
          ImageRepositoryType: 'ECR',
        },
      },
      // AWS-managed.
      Status: 'RUNNING',
      CreatedAt: '2024-01-01T00:00:00Z',
      UpdatedAt: '2024-06-01T00:00:00Z',
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Container — ECS Capacity Provider
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::ECS::CapacityProvider',
    resourceType: 'AWS::ECS::CapacityProvider',
    state: {
      Name: 'asg-capacity',
      AutoScalingGroupProvider: {
        AutoScalingGroupArn:
          'arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:abc:autoScalingGroupName/my-asg',
        ManagedScaling: { Status: 'ENABLED', TargetCapacity: 100 },
        ManagedTerminationProtection: 'ENABLED',
      },
    },
    awsResponse: {
      Name: 'asg-capacity',
      AutoScalingGroupProvider: {
        AutoScalingGroupArn:
          'arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:abc:autoScalingGroupName/my-asg',
        ManagedScaling: { Status: 'ENABLED', TargetCapacity: 100 },
        ManagedTerminationProtection: 'ENABLED',
      },
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Storage — FSx
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::FSx::FileSystem',
    resourceType: 'AWS::FSx::FileSystem',
    state: {
      FileSystemType: 'WINDOWS',
      StorageCapacity: 300,
      SubnetIds: ['subnet-1', 'subnet-2'],
      SecurityGroupIds: ['sg-1'],
    },
    awsResponse: {
      FileSystemType: 'WINDOWS',
      StorageCapacity: 300,
      SubnetIds: ['subnet-1', 'subnet-2'],
      SecurityGroupIds: ['sg-1'],
      // AWS-managed.
      OwnerId: '123456789012',
      CreationTime: '2024-01-01T00:00:00Z',
      Lifecycle: 'AVAILABLE',
    },
  },

  // ──────────────────────────────────────────────────────────────────
  // Compute — EventBridge Pipes
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'AWS::Pipes::Pipe',
    resourceType: 'AWS::Pipes::Pipe',
    state: {
      Name: 'my-pipe',
      RoleArn: 'arn:aws:iam::123456789012:role/PipeRole',
      Source: 'arn:aws:sqs:us-east-1:123456789012:source',
      Target: 'arn:aws:sqs:us-east-1:123456789012:target',
    },
    awsResponse: {
      Name: 'my-pipe',
      RoleArn: 'arn:aws:iam::123456789012:role/PipeRole',
      Source: 'arn:aws:sqs:us-east-1:123456789012:source',
      Target: 'arn:aws:sqs:us-east-1:123456789012:target',
      // AWS-managed.
      CreationTime: '2024-01-01T00:00:00Z',
      LastModifiedTime: '2024-06-01T00:00:00Z',
      CurrentState: 'RUNNING',
      StateReason: '',
    },
  },
];

describe('CC API drift shape fixtures', () => {
  for (const fx of FIXTURES) {
    it(`${fx.name}: clean state produces zero drift`, () => {
      // Skip fixtures whose type ended up on the deny-list — those
      // never reach the comparator at runtime.
      if (CC_API_FALLBACK_DENY_LIST[fx.resourceType]) {
        // If a fixture is deny-listed, it should NOT be in this fixture
        // set in the first place (the fixture exists to verify the
        // type can safely use the CC API path). Fail loudly so we
        // notice the inconsistency rather than silently passing.
        throw new Error(
          `Fixture ${fx.name} has a deny-listed resourceType (${fx.resourceType}). ` +
            `Either remove the fixture or remove the deny-list entry — they contradict each other.`
        );
      }

      const stripped = stripCcApiAwsManagedFields(fx.resourceType, fx.awsResponse);
      const drifts = calculateResourceDrift(fx.state, stripped);

      expect(drifts, `unexpected drift for ${fx.name}: ${JSON.stringify(drifts, null, 2)}`).toEqual(
        []
      );
    });
  }

  it('fixture set covers at least 10 distinct resource types', () => {
    const types = new Set(FIXTURES.map((f) => f.resourceType));
    expect(types.size).toBeGreaterThanOrEqual(10);
  });

  it('detects real drift when the AWS response actually differs', () => {
    // Sanity: confirm the test harness can detect real drift, so a
    // bug in the strip pass that drops a real-state field can't
    // silently pass the suite.
    const state = { GroupName: 'web-sg', GroupDescription: 'Allow HTTP' };
    const aws = { GroupName: 'web-sg', GroupDescription: 'OPEN', OwnerId: '123' };
    const stripped = stripCcApiAwsManagedFields('AWS::EC2::SecurityGroup', aws);
    const drifts = calculateResourceDrift(state, stripped);
    expect(drifts).toEqual([
      { path: 'GroupDescription', stateValue: 'Allow HTTP', awsValue: 'OPEN' },
    ]);
  });
});
