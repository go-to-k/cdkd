/**
 * go-to-k/cdkd#4705 (C): every name-adopting SDK create type the guard is meant
 * to cover can actually be checked. The guard asks only a create whose
 * provider derives its generated name (`generatedCreateName`), and looks the
 * name up with `lookupNames` or, per name, `import`; a type missing either
 * would be created unchecked, silently. Runs through the REAL registration.
 * The list itself is pinned in `replacement-name-holder.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../src/provisioning/register-providers.js';
import { nameAdoptingSdkCreateTypes } from '../../../src/deployment/replacement-name-holder/deploy-name.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';

const providerClasses = await loadProviderClasses();
const registry = new ProviderRegistry();
registerAllProviders(registry, providerClasses);

describe('the name-adopting create types (go-to-k/cdkd#4705)', () => {
  it.each(nameAdoptingSdkCreateTypes())(
    '%s derives its generated name, which carries the stack name, and can look it up',
    (resourceType) => {
      const provider = registry.getProvider(resourceType);
      expect(typeof provider.generatedCreateName).toBe('function');
      const name = withStackName('PerfApp', () =>
        provider.generatedCreateName!(resourceType, 'Thing', {})
      );
      expect(typeof name).toBe('string');
      expect(name!.toLowerCase()).toContain('perfapp');
      expect(typeof provider.lookupNames === 'function' || typeof provider.import === 'function').toBe(
        true
      );
    }
  );

  it.each(nameAdoptingSdkCreateTypes())('%s asks nothing for a name the template declares', (resourceType) => {
    const provider = registry.getProvider(resourceType);
    const declared: Record<string, Record<string, unknown>> = {
      'AWS::CloudWatch::Alarm': { AlarmName: 'mine' },
      'AWS::ECS::Cluster': { ClusterName: 'mine' },
      'AWS::ElasticLoadBalancingV2::LoadBalancer': { Name: 'mine' },
      'AWS::ElasticLoadBalancingV2::TargetGroup': { Name: 'mine' },
      'AWS::Events::Rule': { Name: 'mine' },
      'AWS::Logs::LogGroup': { LogGroupName: 'mine' },
      'AWS::S3::Bucket': { BucketName: 'mine' },
      'AWS::SNS::Topic': { TopicName: 'mine' },
      'AWS::SQS::Queue': { QueueName: 'mine' },
      'AWS::StepFunctions::StateMachine': { StateMachineName: 'mine' },
    };
    expect(
      withStackName('PerfApp', () =>
        provider.generatedCreateName!(resourceType, 'Thing', declared[resourceType]!)
      )
    ).toBeUndefined();
  });
});
