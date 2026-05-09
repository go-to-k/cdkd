import { describe, it, expect, vi, beforeEach } from 'vitest';

// Per-SDK send spies. EC2 and CloudWatch Logs go through getAwsClients(),
// so they're wired via the aws-clients mock below. RDS, ELBv2, ASG,
// and Cognito lazily `new` their own clients with `providerRegion`, so
// their SDK module exports are mocked directly via vi.mock to intercept
// the constructor.
const mockLogsSend = vi.fn();
const mockDdbSend = vi.fn();
const mockEc2Send = vi.fn();
const mockElbv2Send = vi.fn();
const mockRdsSend = vi.fn();
const mockAsgSend = vi.fn();
const mockCognitoSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: {
      send: mockLogsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    dynamoDB: { send: mockDdbSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: mockEc2Send, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const noop = vi.fn();
  type LoggerStub = {
    debug: typeof noop;
    info: typeof noop;
    warn: typeof noop;
    error: typeof noop;
    child: () => LoggerStub;
  };
  const child: LoggerStub = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: () => child,
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    }),
  };
});

// Replace EC2's TerminateInstances waiter so the test does not poll AWS.
vi.mock('@aws-sdk/client-ec2', async () => {
  const real = await vi.importActual<typeof import('@aws-sdk/client-ec2')>('@aws-sdk/client-ec2');
  return {
    ...real,
    waitUntilInstanceTerminated: vi.fn(() => Promise.resolve({ state: 'SUCCESS' })),
  };
});

// RDS client is `new`d lazily inside the provider, so intercept the
// constructor and route every `send(...)` to the shared spy.
vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockRdsSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

// ELBv2 client is `new`d lazily inside the provider — same pattern.
vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-elastic-load-balancing-v2')>(
      '@aws-sdk/client-elastic-load-balancing-v2'
    );
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockElbv2Send,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

// AutoScaling client is `new`d lazily — same pattern as RDS / ELBv2.
vi.mock('@aws-sdk/client-auto-scaling', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-auto-scaling')>(
      '@aws-sdk/client-auto-scaling'
    );
  return {
    ...actual,
    AutoScalingClient: vi.fn().mockImplementation(() => ({
      send: mockAsgSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

// Cognito client — `new`d lazily through createSdkClient inside the provider.
vi.mock('@aws-sdk/client-cognito-identity-provider', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-cognito-identity-provider')>(
      '@aws-sdk/client-cognito-identity-provider'
    );
  return {
    ...actual,
    CognitoIdentityProviderClient: vi.fn().mockImplementation(() => ({
      send: mockCognitoSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

import {
  PutLogGroupDeletionProtectionCommand,
  DeleteLogGroupCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import {
  UpdateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
} from '@aws-sdk/client-dynamodb';
import { ModifyInstanceAttributeCommand, TerminateInstancesCommand } from '@aws-sdk/client-ec2';
import {
  ModifyLoadBalancerAttributesCommand,
  DeleteLoadBalancerCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  ModifyDBInstanceCommand,
  ModifyDBClusterCommand,
  DeleteDBInstanceCommand,
  DeleteDBClusterCommand,
} from '@aws-sdk/client-rds';
import {
  CreateAutoScalingGroupCommand,
  UpdateAutoScalingGroupCommand,
  DeleteAutoScalingGroupCommand,
  DescribeAutoScalingGroupsCommand,
} from '@aws-sdk/client-auto-scaling';
import {
  UpdateUserPoolCommand,
  DescribeUserPoolCommand,
  DeleteUserPoolCommand,
} from '@aws-sdk/client-cognito-identity-provider';

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';

beforeEach(() => {
  mockLogsSend.mockReset().mockResolvedValue({});
  mockDdbSend.mockReset().mockResolvedValue({});
  mockEc2Send.mockReset().mockResolvedValue({});
  mockElbv2Send.mockReset().mockResolvedValue({});
  mockRdsSend.mockReset().mockResolvedValue({});
  mockAsgSend.mockReset().mockResolvedValue({});
  mockCognitoSend.mockReset().mockResolvedValue({});
});

describe('LogsLogGroupProvider --remove-protection', () => {
  it('issues PutLogGroupDeletionProtection with removeProtection=true before delete', async () => {
    const provider = new LogsLogGroupProvider();
    await provider.delete('LG', '/aws/lambda/x', 'AWS::Logs::LogGroup', undefined, {
      removeProtection: true,
    });
    const cmds = mockLogsSend.mock.calls.map((c) => c[0]);
    const flipIdx = cmds.findIndex((c) => c instanceof PutLogGroupDeletionProtectionCommand);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteLogGroupCommand);
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(flipIdx);
    const flipInput = (
      cmds[flipIdx] as unknown as {
        input: { logGroupIdentifier: string; deletionProtectionEnabled: boolean };
      }
    ).input;
    expect(flipInput.deletionProtectionEnabled).toBe(false);
    expect(flipInput.logGroupIdentifier).toBe('/aws/lambda/x');
  });

  it('does NOT issue the flip-off call when removeProtection is unset (default)', async () => {
    const provider = new LogsLogGroupProvider();
    await provider.delete('LG', '/aws/lambda/x', 'AWS::Logs::LogGroup');
    const cmds = mockLogsSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof PutLogGroupDeletionProtectionCommand)).toBe(false);
    expect(cmds.some((c) => c instanceof DeleteLogGroupCommand)).toBe(true);
  });

  it('idempotent — flip-off is issued even when AWS reports already-disabled', async () => {
    const provider = new LogsLogGroupProvider();
    // Both the flip and delete still resolve; verify both were issued.
    await provider.delete('LG', '/aws/lambda/x', 'AWS::Logs::LogGroup', undefined, {
      removeProtection: true,
    });
    expect(mockLogsSend).toHaveBeenCalledTimes(2);
  });
});

describe('DynamoDBTableProvider --remove-protection', () => {
  it('issues UpdateTable(DeletionProtectionEnabled=false) with removeProtection=true before delete', async () => {
    mockDdbSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return Promise.resolve({ Table: { TableStatus: 'ACTIVE' } });
      }
      return Promise.resolve({});
    });
    const provider = new DynamoDBTableProvider();
    await provider.delete('T', 'my-table', 'AWS::DynamoDB::Table', undefined, {
      removeProtection: true,
    });
    const cmds = mockDdbSend.mock.calls.map((c) => c[0]);
    const flipIdx = cmds.findIndex((c) => c instanceof UpdateTableCommand);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteTableCommand);
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(flipIdx);
    const flipInput = (
      cmds[flipIdx] as unknown as {
        input: { TableName: string; DeletionProtectionEnabled: boolean };
      }
    ).input;
    expect(flipInput.TableName).toBe('my-table');
    expect(flipInput.DeletionProtectionEnabled).toBe(false);
  });

  it('does NOT issue UpdateTable when removeProtection is unset', async () => {
    const provider = new DynamoDBTableProvider();
    await provider.delete('T', 'my-table', 'AWS::DynamoDB::Table');
    const cmds = mockDdbSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof UpdateTableCommand)).toBe(false);
    expect(cmds.some((c) => c instanceof DeleteTableCommand)).toBe(true);
  });

  it('idempotent — UpdateTable + ACTIVE wait still issued on already-disabled table', async () => {
    mockDdbSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeTableCommand) {
        return Promise.resolve({ Table: { TableStatus: 'ACTIVE' } });
      }
      return Promise.resolve({});
    });
    const provider = new DynamoDBTableProvider();
    await provider.delete('T', 'my-table', 'AWS::DynamoDB::Table', undefined, {
      removeProtection: true,
    });
    const cmds = mockDdbSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof UpdateTableCommand)).toBe(true);
    expect(cmds.some((c) => c instanceof DeleteTableCommand)).toBe(true);
  });
});

describe('EC2 Instance Provider --remove-protection', () => {
  it('issues ModifyInstanceAttribute(DisableApiTermination=false) before terminate', async () => {
    const provider = new EC2Provider();
    await provider.delete('I', 'i-0123456789abcdef0', 'AWS::EC2::Instance', undefined, {
      removeProtection: true,
    });
    const cmds = mockEc2Send.mock.calls.map((c) => c[0]);
    const flipIdx = cmds.findIndex((c) => c instanceof ModifyInstanceAttributeCommand);
    const termIdx = cmds.findIndex((c) => c instanceof TerminateInstancesCommand);
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(termIdx).toBeGreaterThan(flipIdx);
    const flipInput = (
      cmds[flipIdx] as unknown as {
        input: { InstanceId: string; DisableApiTermination: { Value: boolean } };
      }
    ).input;
    expect(flipInput.InstanceId).toBe('i-0123456789abcdef0');
    expect(flipInput.DisableApiTermination.Value).toBe(false);
  });

  it('does NOT issue ModifyInstanceAttribute when removeProtection is unset', async () => {
    const provider = new EC2Provider();
    await provider.delete('I', 'i-0123456789abcdef0', 'AWS::EC2::Instance');
    const cmds = mockEc2Send.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof ModifyInstanceAttributeCommand)).toBe(false);
    expect(cmds.some((c) => c instanceof TerminateInstancesCommand)).toBe(true);
  });

  it('idempotent — ModifyInstanceAttribute is still issued when termination is already off', async () => {
    const provider = new EC2Provider();
    await provider.delete('I', 'i-0123456789abcdef0', 'AWS::EC2::Instance', undefined, {
      removeProtection: true,
    });
    const cmds = mockEc2Send.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof ModifyInstanceAttributeCommand)).toBe(true);
    expect(cmds.some((c) => c instanceof TerminateInstancesCommand)).toBe(true);
  });
});

describe('ELBv2 LoadBalancer Provider --remove-protection', () => {
  const LB_ARN =
    'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/my-lb/0123456789abcdef';

  it('issues ModifyLoadBalancerAttributes clearing deletion_protection.enabled before delete', async () => {
    const provider = new ELBv2Provider();
    await provider.delete(
      'LB',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      undefined,
      { removeProtection: true }
    );
    const cmds = mockElbv2Send.mock.calls.map((c) => c[0]);
    const flipIdx = cmds.findIndex((c) => c instanceof ModifyLoadBalancerAttributesCommand);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteLoadBalancerCommand);
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(flipIdx);
    const flipInput = (
      cmds[flipIdx] as unknown as {
        input: { LoadBalancerArn: string; Attributes: Array<{ Key: string; Value: string }> };
      }
    ).input;
    expect(flipInput.LoadBalancerArn).toBe(LB_ARN);
    expect(flipInput.Attributes).toEqual([{ Key: 'deletion_protection.enabled', Value: 'false' }]);
  });

  it('does NOT issue ModifyLoadBalancerAttributes when removeProtection is unset', async () => {
    const provider = new ELBv2Provider();
    await provider.delete('LB', LB_ARN, 'AWS::ElasticLoadBalancingV2::LoadBalancer');
    const cmds = mockElbv2Send.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof ModifyLoadBalancerAttributesCommand)).toBe(false);
    expect(cmds.some((c) => c instanceof DeleteLoadBalancerCommand)).toBe(true);
  });

  it('idempotent — flip-off is still issued for an already-unprotected LB', async () => {
    const provider = new ELBv2Provider();
    await provider.delete(
      'LB',
      LB_ARN,
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      undefined,
      { removeProtection: true }
    );
    const cmds = mockElbv2Send.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof ModifyLoadBalancerAttributesCommand)).toBe(true);
    expect(cmds.some((c) => c instanceof DeleteLoadBalancerCommand)).toBe(true);
  });
});

describe('RDS DBInstance --remove-protection', () => {
  it('issues ModifyDBInstance(DeletionProtection=false, ApplyImmediately=true) before delete', async () => {
    mockRdsSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteDBInstanceCommand) return Promise.resolve({});
      if (command instanceof ModifyDBInstanceCommand) return Promise.resolve({});
      // Describe — return empty so the deletion-wait short-circuits.
      const err = new Error('DBInstanceNotFound') as Error & { name: string };
      err.name = 'DBInstanceNotFoundFault';
      return Promise.reject(err);
    });
    const provider = new RDSProvider();
    await provider.delete('DB', 'my-db', 'AWS::RDS::DBInstance', undefined, {
      removeProtection: true,
    });
    const cmds = mockRdsSend.mock.calls.map((c) => c[0]);
    const flipIdx = cmds.findIndex((c) => c instanceof ModifyDBInstanceCommand);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteDBInstanceCommand);
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(flipIdx);
    const flipInput = (
      cmds[flipIdx] as unknown as {
        input: { DeletionProtection: boolean; ApplyImmediately: boolean };
      }
    ).input;
    expect(flipInput.DeletionProtection).toBe(false);
    expect(flipInput.ApplyImmediately).toBe(true);
  });

  it('does NOT issue ModifyDBInstance when removeProtection is unset (gating change vs pre-PR)', async () => {
    mockRdsSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteDBInstanceCommand) return Promise.resolve({});
      const err = new Error('DBInstanceNotFound') as Error & { name: string };
      err.name = 'DBInstanceNotFoundFault';
      return Promise.reject(err);
    });
    const provider = new RDSProvider();
    await provider.delete('DB', 'my-db', 'AWS::RDS::DBInstance');
    const cmds = mockRdsSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof ModifyDBInstanceCommand)).toBe(false);
    expect(cmds.some((c) => c instanceof DeleteDBInstanceCommand)).toBe(true);
  });

  it('idempotent — ModifyDBInstance is issued even when AWS already has protection off', async () => {
    mockRdsSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteDBInstanceCommand) return Promise.resolve({});
      if (command instanceof ModifyDBInstanceCommand) return Promise.resolve({});
      const err = new Error('DBInstanceNotFound') as Error & { name: string };
      err.name = 'DBInstanceNotFoundFault';
      return Promise.reject(err);
    });
    const provider = new RDSProvider();
    await provider.delete('DB', 'my-db', 'AWS::RDS::DBInstance', undefined, {
      removeProtection: true,
    });
    const cmds = mockRdsSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof ModifyDBInstanceCommand)).toBe(true);
  });
});

describe('RDS DBCluster --remove-protection', () => {
  it('issues ModifyDBCluster(DeletionProtection=false) before delete', async () => {
    mockRdsSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteDBClusterCommand) return Promise.resolve({});
      if (command instanceof ModifyDBClusterCommand) return Promise.resolve({});
      const err = new Error('DBClusterNotFound') as Error & { name: string };
      err.name = 'DBClusterNotFoundFault';
      return Promise.reject(err);
    });
    const provider = new RDSProvider();
    await provider.delete('CL', 'my-cl', 'AWS::RDS::DBCluster', undefined, {
      removeProtection: true,
    });
    const cmds = mockRdsSend.mock.calls.map((c) => c[0]);
    const flipIdx = cmds.findIndex((c) => c instanceof ModifyDBClusterCommand);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteDBClusterCommand);
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(flipIdx);
    const flipInput = (
      cmds[flipIdx] as unknown as {
        input: { DBClusterIdentifier: string; DeletionProtection: boolean };
      }
    ).input;
    expect(flipInput.DBClusterIdentifier).toBe('my-cl');
    expect(flipInput.DeletionProtection).toBe(false);
  });

  it('does NOT issue ModifyDBCluster when removeProtection is unset', async () => {
    mockRdsSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteDBClusterCommand) return Promise.resolve({});
      const err = new Error('DBClusterNotFound') as Error & { name: string };
      err.name = 'DBClusterNotFoundFault';
      return Promise.reject(err);
    });
    const provider = new RDSProvider();
    await provider.delete('CL', 'my-cl', 'AWS::RDS::DBCluster');
    const cmds = mockRdsSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof ModifyDBClusterCommand)).toBe(false);
    expect(cmds.some((c) => c instanceof DeleteDBClusterCommand)).toBe(true);
  });

  it('idempotent — ModifyDBCluster is issued even when AWS already has protection off', async () => {
    mockRdsSend.mockImplementation((command: unknown) => {
      if (command instanceof DeleteDBClusterCommand) return Promise.resolve({});
      if (command instanceof ModifyDBClusterCommand) return Promise.resolve({});
      const err = new Error('DBClusterNotFound') as Error & { name: string };
      err.name = 'DBClusterNotFoundFault';
      return Promise.reject(err);
    });
    const provider = new RDSProvider();
    await provider.delete('CL', 'my-cl', 'AWS::RDS::DBCluster', undefined, {
      removeProtection: true,
    });
    const cmds = mockRdsSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof ModifyDBClusterCommand)).toBe(true);
  });
});

describe('ASGProvider --remove-protection', () => {
  // Helper: stub the post-delete waitForGroupDeleted polling so it
  // exits immediately by reporting "group not found".
  const stubWaiter = (command: unknown): Promise<unknown> | undefined => {
    if (command instanceof DescribeAutoScalingGroupsCommand) {
      const err = new Error('AutoScalingGroup name not found') as Error & { name: string };
      err.name = 'ValidationError';
      return Promise.reject(err);
    }
    return undefined;
  };

  it('issues UpdateAutoScalingGroup(DeletionProtection=none) before DeleteAutoScalingGroup with ForceDelete=true', async () => {
    mockAsgSend.mockImplementation((command: unknown) => {
      const stub = stubWaiter(command);
      if (stub) return stub;
      return Promise.resolve({});
    });
    const provider = new ASGProvider();
    await provider.delete('A', 'my-asg', 'AWS::AutoScaling::AutoScalingGroup', undefined, {
      removeProtection: true,
    });
    const cmds = mockAsgSend.mock.calls.map((c) => c[0]);
    const flipIdx = cmds.findIndex((c) => c instanceof UpdateAutoScalingGroupCommand);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteAutoScalingGroupCommand);
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(flipIdx);
    const flipInput = (
      cmds[flipIdx] as unknown as {
        input: { AutoScalingGroupName: string; DeletionProtection: string };
      }
    ).input;
    expect(flipInput.AutoScalingGroupName).toBe('my-asg');
    expect(flipInput.DeletionProtection).toBe('none');
    const delInput = (
      cmds[delIdx] as unknown as {
        input: { AutoScalingGroupName: string; ForceDelete: boolean };
      }
    ).input;
    expect(delInput.AutoScalingGroupName).toBe('my-asg');
    expect(delInput.ForceDelete).toBe(true);
    // No CreateAutoScalingGroup should ever be issued by delete.
    expect(cmds.some((c) => c instanceof CreateAutoScalingGroupCommand)).toBe(false);
  });

  it('does NOT issue UpdateAutoScalingGroup when removeProtection is unset; ForceDelete is false', async () => {
    mockAsgSend.mockImplementation((command: unknown) => {
      const stub = stubWaiter(command);
      if (stub) return stub;
      return Promise.resolve({});
    });
    const provider = new ASGProvider();
    await provider.delete('A', 'my-asg', 'AWS::AutoScaling::AutoScalingGroup');
    const cmds = mockAsgSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof UpdateAutoScalingGroupCommand)).toBe(false);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteAutoScalingGroupCommand);
    expect(delIdx).toBeGreaterThanOrEqual(0);
    const delInput = (
      cmds[delIdx] as unknown as { input: { ForceDelete: boolean } }
    ).input;
    expect(delInput.ForceDelete).toBe(false);
  });

  it('idempotent — UpdateAutoScalingGroup is issued even when AWS already has DeletionProtection=none', async () => {
    mockAsgSend.mockImplementation((command: unknown) => {
      const stub = stubWaiter(command);
      if (stub) return stub;
      return Promise.resolve({});
    });
    const provider = new ASGProvider();
    await provider.delete('A', 'my-asg', 'AWS::AutoScaling::AutoScalingGroup', undefined, {
      removeProtection: true,
    });
    const cmds = mockAsgSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof UpdateAutoScalingGroupCommand)).toBe(true);
  });
});

describe('Cognito UserPool --remove-protection', () => {
  it('with removeProtection=true and templated DeletionProtection=ACTIVE, issues UpdateUserPool flip-off before DeleteUserPool (no Describe needed)', async () => {
    mockCognitoSend.mockResolvedValue({});
    const provider = new CognitoUserPoolProvider();
    await provider.delete(
      'P',
      'us-east-1_abc',
      'AWS::Cognito::UserPool',
      { DeletionProtection: 'ACTIVE' },
      { removeProtection: true }
    );
    const cmds = mockCognitoSend.mock.calls.map((c) => c[0]);
    const flipIdx = cmds.findIndex((c) => c instanceof UpdateUserPoolCommand);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteUserPoolCommand);
    expect(flipIdx).toBeGreaterThanOrEqual(0);
    expect(delIdx).toBeGreaterThan(flipIdx);
    const flipInput = (
      cmds[flipIdx] as unknown as {
        input: { UserPoolId: string; DeletionProtection: string };
      }
    ).input;
    expect(flipInput.UserPoolId).toBe('us-east-1_abc');
    expect(flipInput.DeletionProtection).toBe('INACTIVE');
    // Templated ACTIVE short-circuits the Describe round-trip.
    expect(cmds.some((c) => c instanceof DescribeUserPoolCommand)).toBe(false);
  });

  it('with removeProtection=true and template lacking DeletionProtection, falls back to DescribeUserPool to check AWS-side flag', async () => {
    mockCognitoSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeUserPoolCommand) {
        return Promise.resolve({ UserPool: { DeletionProtection: 'ACTIVE' } });
      }
      return Promise.resolve({});
    });
    const provider = new CognitoUserPoolProvider();
    await provider.delete(
      'P',
      'us-east-1_abc',
      'AWS::Cognito::UserPool',
      undefined,
      { removeProtection: true }
    );
    const cmds = mockCognitoSend.mock.calls.map((c) => c[0]);
    const descIdx = cmds.findIndex((c) => c instanceof DescribeUserPoolCommand);
    const flipIdx = cmds.findIndex((c) => c instanceof UpdateUserPoolCommand);
    const delIdx = cmds.findIndex((c) => c instanceof DeleteUserPoolCommand);
    expect(descIdx).toBeGreaterThanOrEqual(0);
    expect(flipIdx).toBeGreaterThan(descIdx);
    expect(delIdx).toBeGreaterThan(flipIdx);
  });

  it('does NOT issue Describe / Update flip-off when removeProtection is unset (gating change vs pre-PR)', async () => {
    // Pre-PR: bare delete unconditionally issued Describe + (if ACTIVE)
    // Update before Delete. Now: bare delete goes straight to DeleteUserPool
    // and AWS rejects on protected pools instead of silently bypassing.
    mockCognitoSend.mockResolvedValue({});
    const provider = new CognitoUserPoolProvider();
    await provider.delete('P', 'us-east-1_abc', 'AWS::Cognito::UserPool');
    const cmds = mockCognitoSend.mock.calls.map((c) => c[0]);
    expect(cmds.some((c) => c instanceof DescribeUserPoolCommand)).toBe(false);
    expect(cmds.some((c) => c instanceof UpdateUserPoolCommand)).toBe(false);
    expect(cmds.some((c) => c instanceof DeleteUserPoolCommand)).toBe(true);
  });
});
