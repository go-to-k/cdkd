import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Capturable module-level logger fns — unlike intrinsic-functions.test.ts's
// per-call vi.fn() factory, these let the tests assert warn vs debug routing.
const mockWarn = vi.fn();
const mockDebug = vi.fn();

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: mockDebug,
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: () => ({
      debug: mockDebug,
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
    }),
  }),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: vi.fn() },
  }),
}));

import {
  IntrinsicFunctionResolver,
  type ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';

/**
 * Issue #1017: a `Ref` to a resource not in state yet is the EXPECTED case
 * in the diff's best-effort resolution (a Deployment-hash rotation / Lambda
 * currentVersion churn references a resource this same deploy will CREATE).
 * The resolver must still throw (the diff calculator catches and keeps the
 * raw intrinsic), but the not-found log routes to debug — warn stays for
 * deploy-time resolution, where it is a genuine error signal.
 */
describe('IntrinsicFunctionResolver — best-effort Ref-not-found log level (issue #1017)', () => {
  const resolver = new IntrinsicFunctionResolver('us-east-1');

  const baseContext = (): ResolverContext => ({
    template: { Resources: {} },
    resources: {},
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs warn (and throws) for a not-found Ref in the default (deploy) context', async () => {
    await expect(
      resolver.resolve({ Ref: 'ApiDeploymentNewHash123' }, baseContext())
    ).rejects.toThrow('Ref ApiDeploymentNewHash123 not found');

    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('Ref ApiDeploymentNewHash123 not found')
    );
  });

  it('logs debug (and still throws) for a not-found Ref when context.bestEffort is set', async () => {
    await expect(
      resolver.resolve({ Ref: 'ApiDeploymentNewHash123' }, { ...baseContext(), bestEffort: true })
    ).rejects.toThrow('Ref ApiDeploymentNewHash123 not found');

    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockDebug).toHaveBeenCalledWith(
      expect.stringContaining('Ref ApiDeploymentNewHash123 not found')
    );
  });
});
