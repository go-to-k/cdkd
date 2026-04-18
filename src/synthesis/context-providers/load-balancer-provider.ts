import {
  ElasticLoadBalancingV2Client,
  DescribeLoadBalancersCommand,
  DescribeListenersCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import type { ContextProvider, ContextProviderAwsConfig } from './index.js';
import { getLogger } from '../../utils/logger.js';

/**
 * Load Balancer context provider
 *
 * Looks up ALB/NLB details.
 * CDK provider type: "load-balancer"
 */
export class LoadBalancerContextProvider implements ContextProvider {
  private logger = getLogger().child('LoadBalancerContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<unknown> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const loadBalancerArn = props['loadBalancerArn'] as string | undefined;
    const loadBalancerType = props['loadBalancerType'] as string | undefined;

    this.logger.debug(`Looking up load balancer (arn: ${loadBalancerArn}, region: ${region})`);

    const client = new ElasticLoadBalancingV2Client({
      ...(region && { region }),
    });

    try {
      const response = await client.send(
        new DescribeLoadBalancersCommand({
          ...(loadBalancerArn && { LoadBalancerArns: [loadBalancerArn] }),
        })
      );

      let lbs = response.LoadBalancers ?? [];

      if (loadBalancerType) {
        lbs = lbs.filter((lb) => lb.Type === loadBalancerType);
      }

      if (lbs.length === 0) {
        throw new Error(`No load balancer found (arn: ${loadBalancerArn})`);
      }

      const lb = lbs[0]!;
      this.logger.debug(`Resolved load balancer: ${lb.LoadBalancerArn}`);

      return {
        loadBalancerArn: lb.LoadBalancerArn,
        loadBalancerCanonicalHostedZoneId: lb.CanonicalHostedZoneId,
        loadBalancerDnsName: lb.DNSName,
        vpcId: lb.VpcId,
        securityGroupIds: lb.SecurityGroups ?? [],
        ipAddressType: lb.IpAddressType,
      };
    } finally {
      client.destroy();
    }
  }
}

/**
 * Load Balancer Listener context provider
 *
 * Looks up ALB/NLB listener details.
 * CDK provider type: "load-balancer-listener"
 */
export class LoadBalancerListenerContextProvider implements ContextProvider {
  private logger = getLogger().child('LoadBalancerListenerContextProvider');

  constructor(private awsConfig?: ContextProviderAwsConfig) {}

  async resolve(props: Record<string, unknown>): Promise<unknown> {
    const region = (props['region'] as string) || this.awsConfig?.region;
    const listenerArn = props['listenerArn'] as string | undefined;
    const loadBalancerArn = props['loadBalancerArn'] as string | undefined;
    const listenerPort = props['listenerPort'] as number | undefined;
    const listenerProtocol = props['listenerProtocol'] as string | undefined;

    this.logger.debug(
      `Looking up load balancer listener (arn: ${listenerArn}, lb: ${loadBalancerArn}, region: ${region})`
    );

    const client = new ElasticLoadBalancingV2Client({
      ...(region && { region }),
    });

    try {
      const response = await client.send(
        new DescribeListenersCommand({
          ...(listenerArn && { ListenerArns: [listenerArn] }),
          ...(loadBalancerArn && { LoadBalancerArn: loadBalancerArn }),
        })
      );

      let listeners = response.Listeners ?? [];

      if (listenerPort) {
        listeners = listeners.filter((l) => l.Port === listenerPort);
      }
      if (listenerProtocol) {
        listeners = listeners.filter((l) => l.Protocol === listenerProtocol);
      }

      if (listeners.length === 0) {
        throw new Error(
          `No listener found (arn: ${listenerArn}, lb: ${loadBalancerArn}, port: ${listenerPort})`
        );
      }

      const listener = listeners[0]!;
      this.logger.debug(`Resolved listener: ${listener.ListenerArn}`);

      return {
        listenerArn: listener.ListenerArn,
        listenerPort: listener.Port,
        securityGroupIds: [] as string[],
      };
    } finally {
      client.destroy();
    }
  }
}
