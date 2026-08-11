import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';

const TYPE = 'AWS::Route53::HostedZone';
const ZONE_ID = 'Z1234567890';

/**
 * The `route53-provider.ts` row of the #1160 absent-field removal silent-drop
 * umbrella. Both entries are REMOVAL paths the provider had no way to express,
 * and both were confirmed against real CloudFormation by live A/B on
 * 2026-08-10 (a hosted zone with 2 tags + a query logging config, updated to
 * drop one tag and the whole `QueryLoggingConfig` block):
 *
 * - **`HostedZoneTags`** — CFn UNTAGGED the dropped key and left the kept one.
 *   cdkd's `applyHostedZoneTags` only ever sent `AddTags`, so a tag removed
 *   from the template stayed on the zone forever, and the `length === 0` early
 *   return made clearing ALL tags a silent no-op.
 * - **`QueryLoggingConfig`** — CFn DELETED the config (`ListQueryLoggingConfigs`
 *   came back empty). cdkd returned early on an absent block, so the live
 *   config kept writing to CloudWatch — and kept billing — while the template
 *   said otherwise and `cdkd diff` reported no changes. Permanently invisible,
 *   which is the whole shape of the #1160 class.
 *
 * Each behavior gets the #1157 trio: removed -> reset, never-present -> no
 * call, mixed -> the kept values pass through untouched.
 */
describe('Route53Provider HostedZone removal resets (#1160 route53 batch)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
    // Every hosted-zone update ends with a GetHostedZone for the NS read, and
    // opens with UpdateHostedZoneComment. A permissive default keeps each test
    // focused on the command it asserts.
    mockSend.mockResolvedValue({ DelegationSet: { NameServers: [] } });
  });

  const callsOf = (name: string) =>
    mockSend.mock.calls.filter((c) => c[0].constructor.name === name);

  const update = (properties: Record<string, unknown>, previous: Record<string, unknown>) =>
    provider.update('MyZone', ZONE_ID, TYPE, properties, previous);

  // ─── HostedZoneTags ────────────────────────────────────────────────

  describe('HostedZoneTags', () => {
    it('REMOVED: sends RemoveTagKeys for the dropped key, matching CFn', async () => {
      await update(
        { Name: 'example.com', HostedZoneTags: [{ Key: 'Keep', Value: 'yes' }] },
        {
          Name: 'example.com',
          HostedZoneTags: [
            { Key: 'Keep', Value: 'yes' },
            { Key: 'Dropped', Value: 'gone' },
          ],
        }
      );

      const calls = callsOf('ChangeTagsForResourceCommand');
      expect(calls).toHaveLength(1);
      expect(calls[0][0].input).toEqual({
        ResourceType: 'hostedzone',
        ResourceId: ZONE_ID,
        AddTags: [{ Key: 'Keep', Value: 'yes' }],
        RemoveTagKeys: ['Dropped'],
      });
    });

    it('REMOVED ALL: clears every tag, which the length===0 early return used to swallow', async () => {
      await update(
        { Name: 'example.com' },
        { Name: 'example.com', HostedZoneTags: [{ Key: 'Only', Value: 'one' }] }
      );

      const calls = callsOf('ChangeTagsForResourceCommand');
      expect(calls).toHaveLength(1);
      // No AddTags key at all — the API rejects an empty AddTags list, and
      // omitting it is what "remove everything" looks like on the wire.
      expect(calls[0][0].input).toEqual({
        ResourceType: 'hostedzone',
        ResourceId: ZONE_ID,
        RemoveTagKeys: ['Only'],
      });
    });

    it('NEVER PRESENT: issues no tag call at all', async () => {
      await update({ Name: 'example.com' }, { Name: 'example.com' });

      expect(callsOf('ChangeTagsForResourceCommand')).toHaveLength(0);
    });

    it('MIXED: a changed VALUE is re-added and untouched siblings pass through', async () => {
      await update(
        {
          Name: 'example.com',
          HostedZoneTags: [
            { Key: 'Env', Value: 'prod' },
            { Key: 'Team', Value: 'core' },
          ],
        },
        {
          Name: 'example.com',
          HostedZoneTags: [
            { Key: 'Env', Value: 'dev' },
            { Key: 'Team', Value: 'core' },
          ],
        }
      );

      const calls = callsOf('ChangeTagsForResourceCommand');
      expect(calls).toHaveLength(1);
      expect(calls[0][0].input.AddTags).toEqual([
        { Key: 'Env', Value: 'prod' },
        { Key: 'Team', Value: 'core' },
      ]);
      // A key present on BOTH sides must never appear as a removal — sending a
      // key in AddTags and RemoveTagKeys at once asks the API to arbitrate.
      expect(calls[0][0].input.RemoveTagKeys).toBeUndefined();
    });

    it('CREATE is unchanged: no previous side, so nothing is ever removed', async () => {
      mockSend.mockResolvedValue({
        HostedZone: { Id: `/hostedzone/${ZONE_ID}` },
        DelegationSet: { NameServers: [] },
      });

      await provider.create('MyZone', TYPE, {
        Name: 'example.com',
        HostedZoneTags: [{ Key: 'Env', Value: 'prod' }],
      });

      const calls = callsOf('ChangeTagsForResourceCommand');
      expect(calls).toHaveLength(1);
      expect(calls[0][0].input.RemoveTagKeys).toBeUndefined();
    });

    it('a MALFORMED desired list does NOT untag the live zone', async () => {
      // The destructive direction of the #1471 / #1493 rule. A malformed
      // desired value reads as `[]` at the value level, which is
      // indistinguishable from "the user removed every tag" — so acting on it
      // would UNTAG a live zone on the strength of an unresolved intrinsic.
      // It warns and leaves AWS alone instead, and never throws (the previous
      // side is state-borne, so a refusal would fire on a rollback replay the
      // user cannot edit).
      await expect(
        update(
          { Name: 'example.com', HostedZoneTags: 'not-a-list' },
          { Name: 'example.com', HostedZoneTags: [{ Key: 'Old', Value: 'x' }] }
        )
      ).resolves.toBeDefined();

      expect(callsOf('ChangeTagsForResourceCommand')).toHaveLength(0);
    });

    it('a per-ENTRY malformed tag does NOT untag its live siblings', async () => {
      // The container-level guard is not enough: `[{ Key: { Ref: 'X' } }]` IS
      // genuinely an array, so a shape-only check waves it through, the entry
      // is dropped by the reader, and its key falls out of `desiredKeys` — so
      // the sibling that IS well-formed gets untagged on the strength of an
      // unresolved intrinsic. A LOSSY read makes the whole list unusable.
      await update(
        {
          Name: 'example.com',
          HostedZoneTags: [
            { Key: 'Keep', Value: 'yes' },
            { Key: { Ref: 'Unresolved' }, Value: 'v' },
          ],
        },
        {
          Name: 'example.com',
          HostedZoneTags: [
            { Key: 'Keep', Value: 'yes' },
            { Key: 'Resolved', Value: 'v' },
          ],
        }
      );

      expect(callsOf('ChangeTagsForResourceCommand')).toHaveLength(0);
    });

    it('a tag entry with a non-string Value is lossy too, so the call is skipped', async () => {
      // Route 53 rejects a non-string value, and because Add and Remove ride
      // the SAME request, letting it through would fail the whole call and take
      // the REMOVALS down with it — silently defeating the fix.
      await update(
        { Name: 'example.com', HostedZoneTags: [{ Key: 'Env', Value: 42 }] },
        { Name: 'example.com', HostedZoneTags: [{ Key: 'Old', Value: 'x' }] }
      );

      expect(callsOf('ChangeTagsForResourceCommand')).toHaveLength(0);
    });

    it('an explicit EMPTY list clears every tag', async () => {
      await update(
        { Name: 'example.com', HostedZoneTags: [] },
        { Name: 'example.com', HostedZoneTags: [{ Key: 'Gone', Value: 'x' }] }
      );

      const calls = callsOf('ChangeTagsForResourceCommand');
      expect(calls).toHaveLength(1);
      expect(calls[0][0].input.RemoveTagKeys).toEqual(['Gone']);
    });

    it('a NULL desired value is a removal, not a malformed value', async () => {
      // `HostedZoneTags:` with an empty YAML value parses to null, and CFn
      // treats an explicitly-null property as removed. Pinned because the
      // malformed guard deliberately lets `null` through to the removal path
      // while refusing every other non-array — an asymmetry worth stating.
      await update(
        { Name: 'example.com', HostedZoneTags: null },
        { Name: 'example.com', HostedZoneTags: [{ Key: 'A', Value: 'x' }] }
      );

      const calls = callsOf('ChangeTagsForResourceCommand');
      expect(calls).toHaveLength(1);
      expect(calls[0][0].input.RemoveTagKeys).toEqual(['A']);
    });

    it('a failed REMOVAL throws, because state will not record it for a retry', async () => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'ChangeTagsForResourceCommand') {
          return Promise.reject(new Error('AccessDenied'));
        }
        return Promise.resolve({ DelegationSet: { NameServers: [] } });
      });

      await expect(
        update(
          { Name: 'example.com' },
          { Name: 'example.com', HostedZoneTags: [{ Key: 'Gone', Value: 'x' }] }
        )
      ).rejects.toThrow(/Failed to remove tag\(s\) Gone.*will NOT be retried/s);
    });

    it('a failed ADD-only call still only warns, since the next deploy retries it', async () => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'ChangeTagsForResourceCommand') {
          return Promise.reject(new Error('Throttling'));
        }
        return Promise.resolve({ DelegationSet: { NameServers: [] } });
      });

      await expect(
        update(
          { Name: 'example.com', HostedZoneTags: [{ Key: 'New', Value: 'x' }] },
          { Name: 'example.com' }
        )
      ).resolves.toBeDefined();
    });

    it('de-duplicates removal keys from a repeated previous entry', async () => {
      await update(
        { Name: 'example.com' },
        {
          Name: 'example.com',
          HostedZoneTags: [
            { Key: 'Dup', Value: 'a' },
            { Key: 'Dup', Value: 'b' },
          ],
        }
      );

      const calls = callsOf('ChangeTagsForResourceCommand');
      expect(calls[0][0].input.RemoveTagKeys).toEqual(['Dup']);
    });

    it('a malformed PREVIOUS list still lets a well-formed desired side apply', async () => {
      // Only the DESIRED side gates the removal computation; a state record an
      // older binary wrote must not block an ordinary update.
      await expect(
        update(
          { Name: 'example.com', HostedZoneTags: [{ Key: 'New', Value: 'v' }] },
          { Name: 'example.com', HostedZoneTags: 'not-a-list' }
        )
      ).resolves.toBeDefined();

      const calls = callsOf('ChangeTagsForResourceCommand');
      expect(calls).toHaveLength(1);
      expect(calls[0][0].input.AddTags).toEqual([{ Key: 'New', Value: 'v' }]);
      expect(calls[0][0].input.RemoveTagKeys).toBeUndefined();
    });
  });

  // ─── QueryLoggingConfig ────────────────────────────────────────────

  describe('QueryLoggingConfig', () => {
    it('REMOVED: deletes the live config, which used to survive forever', async () => {
      // STATEFUL: the config exists until the Delete lands, then it is gone.
      // The removal path re-lists afterwards to VERIFY the delete, so a mock
      // that keeps returning the config forever would (correctly) trip the
      // did-not-land guard.
      let live = [{ Id: 'qlc-1' }];
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'ListQueryLoggingConfigsCommand') {
          return Promise.resolve({ QueryLoggingConfigs: live });
        }
        if (command.constructor.name === 'DeleteQueryLoggingConfigCommand') {
          live = [];
          return Promise.resolve({});
        }
        return Promise.resolve({ DelegationSet: { NameServers: [] } });
      });

      await update(
        { Name: 'example.com' },
        {
          Name: 'example.com',
          QueryLoggingConfig: { CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:1:log-group:/aws/route53/x' },
        }
      );

      expect(callsOf('ListQueryLoggingConfigsCommand').length).toBeGreaterThanOrEqual(1);
      const deletes = callsOf('DeleteQueryLoggingConfigCommand');
      expect(deletes).toHaveLength(1);
      expect(deletes[0][0].input).toEqual({ Id: 'qlc-1' });
      // The removal must NOT re-create anything.
      expect(callsOf('CreateQueryLoggingConfigCommand')).toHaveLength(0);
    });

    it('NEVER PRESENT: costs no ListQueryLoggingConfigs call on an ordinary update', async () => {
      // Probing on every hosted-zone update would burn an API call per deploy
      // to discover nothing, so the removal is gated on the PREVIOUS side.
      await update({ Name: 'example.com' }, { Name: 'example.com' });

      expect(callsOf('ListQueryLoggingConfigsCommand')).toHaveLength(0);
      expect(callsOf('DeleteQueryLoggingConfigCommand')).toHaveLength(0);
    });

    it('KEPT: still replaces the config rather than treating it as a removal', async () => {
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'ListQueryLoggingConfigsCommand') {
          return Promise.resolve({ QueryLoggingConfigs: [{ Id: 'qlc-old' }] });
        }
        return Promise.resolve({ DelegationSet: { NameServers: [] } });
      });

      const arn = 'arn:aws:logs:us-east-1:1:log-group:/aws/route53/new';
      await update(
        { Name: 'example.com', QueryLoggingConfig: { CloudWatchLogsLogGroupArn: arn } },
        {
          Name: 'example.com',
          QueryLoggingConfig: { CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:1:log-group:/aws/route53/old' },
        }
      );

      const creates = callsOf('CreateQueryLoggingConfigCommand');
      expect(creates).toHaveLength(1);
      expect(creates[0][0].input).toEqual({
        HostedZoneId: ZONE_ID,
        CloudWatchLogsLogGroupArn: arn,
      });
    });

    it('CREATE is unchanged: an absent block is still a plain no-op', async () => {
      mockSend.mockResolvedValue({
        HostedZone: { Id: `/hostedzone/${ZONE_ID}` },
        DelegationSet: { NameServers: [] },
      });

      await provider.create('MyZone', TYPE, { Name: 'example.com' });

      expect(callsOf('ListQueryLoggingConfigsCommand')).toHaveLength(0);
      expect(callsOf('DeleteQueryLoggingConfigCommand')).toHaveLength(0);
    });

    it('a BLANK ARN on the previous side is not a removal trigger', async () => {
      // Both sides go through one reader, so a shape that never produced a
      // live config cannot manufacture a delete of something else.
      await update(
        { Name: 'example.com' },
        { Name: 'example.com', QueryLoggingConfig: { CloudWatchLogsLogGroupArn: '' } }
      );

      expect(callsOf('ListQueryLoggingConfigsCommand')).toHaveLength(0);
    });

    it('a MALFORMED previous container is not a removal trigger either', async () => {
      await update(
        { Name: 'example.com' },
        { Name: 'example.com', QueryLoggingConfig: 'arn:aws:logs:us-east-1:1:log-group:/x' }
      );

      expect(callsOf('ListQueryLoggingConfigsCommand')).toHaveLength(0);
    });

    it('a MALFORMED desired block does NOT delete the live config', async () => {
      // Same destructive direction as the tag case: only a genuinely ABSENT
      // block means "removed". A present block this provider cannot use warns
      // and leaves AWS alone — which is also the pre-#1160 behavior for that
      // shape, so the fix cannot regress a template that used to be a no-op
      // into one that deletes.
      await update(
        { Name: 'example.com', QueryLoggingConfig: 'arn:aws:logs:us-east-1:1:log-group:/x' },
        {
          Name: 'example.com',
          QueryLoggingConfig: {
            CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:1:log-group:/aws/route53/x',
          },
        }
      );

      expect(callsOf('ListQueryLoggingConfigsCommand')).toHaveLength(0);
      expect(callsOf('DeleteQueryLoggingConfigCommand')).toHaveLength(0);
      expect(callsOf('CreateQueryLoggingConfigCommand')).toHaveLength(0);
    });

    it('a desired block with a BLANK arn is likewise not a delete', async () => {
      // Asserting only the Delete count would pass VACUOUSLY: the default mock
      // returns no QueryLoggingConfigs, so a Delete could never be emitted no
      // matter what the provider did. Assert the List probe never happens —
      // that is the call the removal path makes FIRST, so it is the one that
      // actually discriminates.
      await update(
        { Name: 'example.com', QueryLoggingConfig: { CloudWatchLogsLogGroupArn: '' } },
        {
          Name: 'example.com',
          QueryLoggingConfig: {
            CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:1:log-group:/aws/route53/x',
          },
        }
      );

      expect(callsOf('ListQueryLoggingConfigsCommand')).toHaveLength(0);
      expect(callsOf('DeleteQueryLoggingConfigCommand')).toHaveLength(0);
    });

    it('an EMPTY object is a removal, because that is what readHostedZone emits', async () => {
      // `readHostedZone` returns `QueryLoggingConfig: {}` as the canonical "no
      // live config", and `cdkd drift --revert` feeds `observedProperties` back
      // as the DESIRED side. Treating `{}` as malformed would warn on every
      // hosted-zone revert and tell the user to omit a block they never wrote,
      // so a key-less object is ABSENT rather than unusable.
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'ListQueryLoggingConfigsCommand') {
          return Promise.resolve({ QueryLoggingConfigs: [] });
        }
        return Promise.resolve({ DelegationSet: { NameServers: [] } });
      });

      await update(
        { Name: 'example.com', QueryLoggingConfig: {} },
        {
          Name: 'example.com',
          QueryLoggingConfig: {
            CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:1:log-group:/aws/route53/x',
          },
        }
      );

      // Two List calls: the delete helper's own, plus the post-delete
      // verification the removal path adds.
      expect(callsOf('ListQueryLoggingConfigsCommand')).toHaveLength(2);
    });

    it('a removal whose delete did not land THROWS, because it is never retried', async () => {
      // The delete helper swallows its own failures, which is right on create /
      // destroy. On removal it is not: state is rewritten without the property,
      // so the next deploy's previous side no longer carries it and the config
      // bills forever with `cdkd diff` clean.
      mockSend.mockImplementation((command: { constructor: { name: string } }) => {
        if (command.constructor.name === 'ListQueryLoggingConfigsCommand') {
          return Promise.resolve({ QueryLoggingConfigs: [{ Id: 'qlc-stuck' }] });
        }
        if (command.constructor.name === 'DeleteQueryLoggingConfigCommand') {
          return Promise.reject(new Error('AccessDenied'));
        }
        return Promise.resolve({ DelegationSet: { NameServers: [] } });
      });

      await expect(
        update(
          { Name: 'example.com' },
          {
            Name: 'example.com',
            QueryLoggingConfig: {
              CloudWatchLogsLogGroupArn: 'arn:aws:logs:us-east-1:1:log-group:/aws/route53/x',
            },
          }
        )
      ).rejects.toThrow(/is still present.*will NOT.*be retried/s);
    });
  });
});
