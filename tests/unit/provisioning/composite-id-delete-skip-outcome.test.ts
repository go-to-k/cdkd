import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #1752: the five warn-and-continue DELETE arms for a malformed composite
 * physicalId used to `return;`. The destroy runner's only signal is the return
 * value, so a bare `return` was indistinguishable from a completed delete — it
 * printed `✓ <id> (<type>) deleted`, counted the resource toward `N deleted`,
 * and dropped its state record, all while the AWS resource stayed alive.
 *
 * These tests pin the OUTCOME (not the message — that is
 * `composite-id-decode-message-sites.test.ts`'s job) for every arm, so a future
 * arm that forgets to report the skip fails here instead of silently
 * re-introducing the mis-accounting.
 *
 * The `noSend()` assertion beside each one is what makes the outcome
 * meaningful: `'skipped'` claims NO AWS call was issued.
 */

const warnSpy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

const stubClient = vi.hoisted(
  () => () => ({ send, config: { region: () => Promise.resolve('us-east-1') } })
);

vi.mock('@aws-sdk/client-ec2', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-ec2');
  return { ...actual, EC2Client: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-glue', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-glue');
  return { ...actual, GlueClient: vi.fn().mockImplementation(stubClient) };
});
vi.mock('@aws-sdk/client-appsync', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@aws-sdk/client-appsync');
  return { ...actual, AppSyncClient: vi.fn().mockImplementation(stubClient) };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { GlueProvider } from '../../../src/provisioning/providers/glue-provider.js';
import { AppSyncProvider } from '../../../src/provisioning/providers/appsync-provider.js';
import { COMPOSITE_ID_SKIP_REASON } from '../../../src/provisioning/composite-id.js';

describe('malformed-composite-id DELETE arms report outcome: skipped (issue #1752)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const noSend = () => expect(send).not.toHaveBeenCalled();

  const cases: Array<{
    name: string;
    run: () => Promise<unknown>;
  }> = [
    {
      name: 'AWS::Glue::Table',
      run: () => new GlueProvider().delete('MyTable', 'mydb', 'AWS::Glue::Table'),
    },
    {
      name: 'AWS::EC2::NetworkAclEntry',
      run: () => new EC2Provider().delete('MyEntry', 'acl-123', 'AWS::EC2::NetworkAclEntry'),
    },
    {
      name: 'AWS::AppSync::DataSource',
      run: () => new AppSyncProvider().delete('MyDs', 'onlyone', 'AWS::AppSync::DataSource'),
    },
    {
      name: 'AWS::AppSync::Resolver',
      run: () => new AppSyncProvider().delete('MyRes', 'abc|onlyTwo', 'AWS::AppSync::Resolver'),
    },
    {
      name: 'AWS::AppSync::ApiKey',
      run: () => new AppSyncProvider().delete('MyKey', 'onlyone', 'AWS::AppSync::ApiKey'),
    },
  ];

  it.each(cases)('$name reports the skip and issues no AWS call', async ({ run }) => {
    const result = await run();

    expect(result).toEqual({ outcome: 'skipped', reason: COMPOSITE_ID_SKIP_REASON });
    // A `'skipped'` outcome asserts nothing was attempted — pin it.
    noSend();
    // The full remediation text still goes out beside the machine-readable
    // outcome (the reason field is the short form for the status line).
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('LEFT IN PLACE');
  });

  it('the shared reason names the state record, not an AWS failure', () => {
    // The wording is user-facing on the destroy status line, and a reason that
    // read like an AWS error would send the user to the wrong place: the
    // repair is in state.json, not in AWS.
    expect(COMPOSITE_ID_SKIP_REASON).toContain('physicalId');
    expect(COMPOSITE_ID_SKIP_REASON).toContain('state');
    expect(COMPOSITE_ID_SKIP_REASON).toContain('no delete issued');
  });

  // Inverted controls: a guard that fired UNCONDITIONALLY would satisfy every
  // assertion above, so each arm needs a well-formed id that must NOT skip.
  const wellFormed: Array<{ name: string; run: () => Promise<unknown> }> = [
    {
      name: 'AWS::Glue::Table',
      run: () => new GlueProvider().delete('MyTable', 'mydb|mytable', 'AWS::Glue::Table'),
    },
    {
      name: 'AWS::EC2::NetworkAclEntry',
      run: () =>
        new EC2Provider().delete('MyEntry', 'acl-123|100|false', 'AWS::EC2::NetworkAclEntry'),
    },
    {
      name: 'AWS::AppSync::DataSource',
      run: () => new AppSyncProvider().delete('MyDs', 'api1|ds1', 'AWS::AppSync::DataSource'),
    },
    {
      name: 'AWS::AppSync::Resolver',
      run: () =>
        new AppSyncProvider().delete('MyRes', 'api1|Query|field', 'AWS::AppSync::Resolver'),
    },
    {
      name: 'AWS::AppSync::ApiKey',
      run: () => new AppSyncProvider().delete('MyKey', 'api1|key1', 'AWS::AppSync::ApiKey'),
    },
  ];

  it.each(wellFormed)('$name: a WELL-FORMED id deletes and reports no skip', async ({ run }) => {
    send.mockResolvedValue({});

    await expect(run()).resolves.toBeUndefined();

    // The delete really went out — otherwise "no skip" would also be satisfied
    // by an arm that silently did nothing.
    expect(send).toHaveBeenCalled();
  });
});
