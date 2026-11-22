import { createOnlyOf, type TypeCase } from './sdk-wire-harness.js';
import { LightsailAlarmProvider } from '../../../src/provisioning/providers/lightsail-alarm-provider.js';

/**
 * The Lightsail alarm wire case (go-to-k/cdkd#6830). Run by
 * `sdk-wire-coverage-lightsail.test.ts`, which mocks the client the provider
 * builds; the ledger in `sdk-wire-coverage.test.ts` counts it as covered. The
 * provider's token bucket is replaced, so the probes do not wait out
 * Lightsail's one-per-second refill.
 */

// Not a gap: `PutAlarm` replaces the whole alarm from `next`, so a member
// removed from the template is cleared by omission.
const ALARM_FULL_PUT = 'PutAlarm replaces the whole alarm from next; prev is not read';

export const CASES_LIGHTSAIL: TypeCase[] = [
  {
    resourceType: 'AWS::Lightsail::Alarm',
    provider: () => {
      const provider = new LightsailAlarmProvider();
      provider.takeToken = async () => {};
      return provider;
    },
    physicalId: 'a',
    createOnly: createOnlyOf('AWS::Lightsail::Alarm'),
    wholeFromNext: { keys: () => true, reason: ALARM_FULL_PUT },
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          AlarmName: 'a',
          MonitoredResourceName: 'instance-1',
          MetricName: 'CPUUtilization',
          ComparisonOperator: 'GreaterThanOrEqualToThreshold',
          EvaluationPeriods: 2,
          Threshold: 90,
          DatapointsToAlarm: 1,
          TreatMissingData: 'breaching',
          ContactProtocols: ['Email'],
          NotificationTriggers: ['ALARM', 'OK'],
          NotificationEnabled: false,
        },
      },
    ],
  },
];
