import { describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The client class the CloudWatch Logs delivery providers reach
// (`sdk-wire-cases-logs-delivery.ts`), wrapped as in `sdk-wire-coverage.test.ts`.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-cloudwatch-logs', (orig) => wrap(orig, 'CloudWatchLogsClient'));

import { CASES_LOGS_DELIVERY } from './sdk-wire-cases-logs-delivery.js';

describe('SDK wire coverage (CloudWatch Logs deliveries)', () => {
  describeWireCases(CASES_LOGS_DELIVERY);
});
