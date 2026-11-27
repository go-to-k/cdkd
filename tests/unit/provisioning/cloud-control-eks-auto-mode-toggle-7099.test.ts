import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#7099 part B: a lone EKS `KubernetesNetworkConfig.
// ElasticLoadBalancing.Enabled` toggle is reported applied and is not, through
// Cloud Control and CloudFormation alike (measured). cdkd refuses it before
// any call, naming the Auto Mode settings to change with it.

const mockCcSend = vi.fn();
const mockCfnSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCcSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: mockCfnSend },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import { assertEksAutoModeToggleComplete } from '../../../src/provisioning/cloud-control/eks-auto-mode-toggle.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const T = 'AWS::EKS::Cluster';
const knc = (enabled?: boolean | string) =>
  enabled === undefined ? {} : { KubernetesNetworkConfig: { ElasticLoadBalancing: { Enabled: enabled } } };
const trio = (enabled: boolean) => ({
  ...knc(enabled),
  ComputeConfig: { Enabled: enabled },
  StorageConfig: { BlockStorage: { Enabled: enabled } },
});

const check = (properties: Record<string, unknown>, previousProperties: Record<string, unknown>) =>
  (): void =>
    assertEksAutoModeToggleComplete({
      resourceType: T,
      logicalId: 'Cluster',
      physicalId: 'c',
      properties: { Name: 'c', ...properties },
      previousProperties: { Name: 'c', ...previousProperties },
    });

describe('a lone EKS load-balancing toggle (go-to-k/cdkd#7099)', () => {
  beforeEach(() => {
    mockCcSend.mockReset();
    mockCfnSend.mockReset();
    clearCreateOnlyPropertiesCache();
  });

  it('is refused through the provider before any AWS call', async () => {
    const err = await new CloudControlProvider()
      .update('Cluster', 'c', T, { Name: 'c', ...knc(true) }, { Name: 'c', ...knc(false) })
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain(
      'KubernetesNetworkConfig.ElasticLoadBalancing.Enabled changes to true, but ComputeConfig.Enabled and StorageConfig.BlockStorage.Enabled are not true'
    );
    expect(mockCcSend).not.toHaveBeenCalled();
    expect(mockCfnSend).not.toHaveBeenCalled();
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('refuses turning it on over a cluster that never declared it, naming the one missing companion', () => {
    expect(
      check({ ...knc(true), ComputeConfig: { Enabled: true } }, {})
    ).toThrow(/but StorageConfig\.BlockStorage\.Enabled is not true/);
  });

  it('refuses turning it off while the companions stay on', () => {
    expect(
      check({ ...trio(true), ...knc(false) }, trio(true))
    ).toThrow(/changes to false, but ComputeConfig\.Enabled and StorageConfig\.BlockStorage\.Enabled are not false/);
  });

  it('lets the three settings through together, on and off', () => {
    expect(check(trio(true), knc(false))).not.toThrow();
    expect(check(trio(false), trio(true))).not.toThrow();
  });

  it('lets through an unchanged value, a string spelling, a removal and other types', () => {
    expect(check(knc(true), knc('true'))).not.toThrow();
    expect(check(knc(false), {})).not.toThrow();
    // The rollback replay of an applied trio: the template it returns to
    // never declared the member.
    expect(check({}, trio(true))).not.toThrow();
    expect(() =>
      assertEksAutoModeToggleComplete({
        resourceType: 'AWS::EKS::Nodegroup',
        logicalId: 'N',
        physicalId: 'n',
        properties: knc(true),
        previousProperties: knc(false),
      })
    ).not.toThrow();
  });
});
