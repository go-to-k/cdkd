import { describe, vi } from 'vite-plus/test';
import { describeWireCases } from './sdk-wire-harness.js';

// The provider builds its own AppConfig client; a tag update also reaches the
// shared STS client for the account in the environment ARN.
const { wrap } = vi.hoisted(() => ({
  wrap: async (orig: () => Promise<Record<string, unknown>>, className: string) =>
    (await import('./sdk-wire-harness.js')).wrapClientModule(await orig(), className),
}));
vi.mock('@aws-sdk/client-appconfig', (orig) => wrap(orig, 'AppConfigClient'));
vi.mock('@aws-sdk/client-sts', (orig) => wrap(orig, 'STSClient'));

import { CASES_APPCONFIG } from './sdk-wire-cases-appconfig.js';

describe('SDK wire coverage (AppConfig)', () => {
  describeWireCases(CASES_APPCONFIG);
});
