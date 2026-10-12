import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetBucketLifecycleConfigurationCommand,
  ListObjectsV2Command,
  PutBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  type S3Client,
} from '@aws-sdk/client-s3';
// The deploy-path owner resolution, steerable per test (default: unresolved,
// which is what a bare `{ send }` double gets from the real helper).
const ownerParam = vi.hoisted(() => ({ value: {} as { ExpectedBucketOwner?: string } }));
vi.mock('../../../src/utils/expected-bucket-owner.js', () => ({
  expectedOwnerParam: async () => ownerParam.value,
}));

import {
  applyCustomResourceResponseExpiration,
  ensureCustomResourceResponseExpirationOnce,
  resetCustomResourceResponseExpirationMemo,
  CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID,
} from '../../../src/state/state-bucket-lifecycle.js';

// Issue #2353: the state bucket's lifecycle configuration gains a one-day
// expiration rule for `custom-resource-responses/`. PutBucketLifecycleConfiguration
// REPLACES the whole configuration, so the properties under test are that the
// user's rules survive byte-for-byte, that nothing is written when the current
// configuration could not be read, and that the call never throws.

const BUCKET = 'cdkd-state-123456789012';

const OUR_RULE_FILTER_FORM: LifecycleRule = {
  ID: CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID,
  Status: 'Enabled',
  Filter: { Prefix: 'custom-resource-responses/cdkd-1' },
  Expiration: { Days: 1 },
  NoncurrentVersionExpiration: { NoncurrentDays: 1 },
};

const USER_RULES: LifecycleRule[] = [
  {
    ID: 'user-logs',
    Status: 'Enabled',
    Filter: { And: { Prefix: 'logs/', Tags: [{ Key: 'tier', Value: 'cold' }] } },
    Transitions: [{ Days: 30, StorageClass: 'GLACIER' }],
  },
  {
    // Overlaps cdkd's prefix on purpose: S3 accepts overlapping Filter-form
    // rules, so it must be written back untouched, not dropped or edited.
    ID: 'user-whole-bucket',
    Status: 'Disabled',
    Filter: {},
    AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
  },
];

function accessDenied(): Error {
  return Object.assign(new Error('User: arn:aws:sts::123456789012:assumed-role/x is not authorized'), {
    name: 'AccessDenied',
  });
}

function noSuchLifecycle(): Error {
  return Object.assign(new Error('The lifecycle configuration does not exist'), {
    name: 'NoSuchLifecycleConfiguration',
  });
}

/**
 * An S3 client whose lifecycle GET answers `get`, whose PUT answers `put`, and
 * whose listing of the response prefix answers `list` (default: responses only).
 */
function fakeS3(
  get: () => Promise<unknown>,
  put: () => Promise<unknown> = async () => ({}),
  list: (input: { ContinuationToken?: string }) => Promise<unknown> = async () => ({
    Contents: [{ Key: 'custom-resource-responses/cdkd-1-a.json' }],
  })
) {
  const send = vi.fn(async (command: object) => {
    if (command instanceof GetBucketLifecycleConfigurationCommand) return get();
    if (command instanceof PutBucketLifecycleConfigurationCommand) return put();
    if (command instanceof ListObjectsV2Command) return list(command.input);
    throw new Error(`unexpected command ${command.constructor.name}`);
  });
  return { client: { send } as unknown as S3Client, send };
}

function puts(send: ReturnType<typeof vi.fn>): PutBucketLifecycleConfigurationCommand[] {
  return send.mock.calls
    .map((c) => c[0] as object)
    .filter(
      (c): c is PutBucketLifecycleConfigurationCommand =>
        c instanceof PutBucketLifecycleConfigurationCommand
    );
}

describe('applyCustomResourceResponseExpiration (issue #2353)', () => {
  it('writes only the cdkd rule, in Filter form, to a bucket with no lifecycle configuration', async () => {
    const { client, send } = fakeS3(async () => {
      throw noSuchLifecycle();
    });

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome).toEqual({ status: 'added' });
    const [put] = puts(send);
    expect(put?.input.Bucket).toBe(BUCKET);
    expect(put?.input.LifecycleConfiguration?.Rules).toEqual([OUR_RULE_FILTER_FORM]);
    expect(put?.input).not.toHaveProperty('TransitionDefaultMinimumObjectSize');
  });

  it("merges: every existing rule is written back unchanged and in order, with the cdkd rule appended", async () => {
    const { client, send } = fakeS3(async () => ({
      Rules: structuredClone(USER_RULES),
      TransitionDefaultMinimumObjectSize: 'varies_by_storage_class',
    }));

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome).toEqual({ status: 'added' });
    const all = puts(send);
    expect(all).toHaveLength(1);
    expect(all[0]?.input.LifecycleConfiguration?.Rules).toEqual([
      ...USER_RULES,
      OUR_RULE_FILTER_FORM,
    ]);
    // Left out, the PUT would reset the bucket's setting to the S3 default.
    expect(all[0]?.input.TransitionDefaultMinimumObjectSize).toBe('varies_by_storage_class');
  });

  it('is idempotent: a configuration already carrying the rule ID gets no PUT, whatever its body', async () => {
    const edited: LifecycleRule = { ...OUR_RULE_FILTER_FORM, Expiration: { Days: 3 } };
    const { client, send } = fakeS3(async () => ({ Rules: [USER_RULES[0], edited] }));

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome).toEqual({ status: 'present' });
    expect(puts(send)).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('writes the rule-level Prefix form when an existing rule uses it (S3 refuses a mix)', async () => {
    const legacy: LifecycleRule = {
      ID: 'legacy',
      Status: 'Enabled',
      Prefix: 'old/',
      Expiration: { Days: 90 },
    };
    const { client, send } = fakeS3(async () => ({ Rules: [legacy] }));

    await applyCustomResourceResponseExpiration(client, BUCKET);

    const rules = puts(send)[0]?.input.LifecycleConfiguration?.Rules;
    expect(rules?.[0]).toEqual(legacy);
    expect(rules?.[1]).toEqual({
      ID: CUSTOM_RESOURCE_RESPONSE_LIFECYCLE_RULE_ID,
      Status: 'Enabled',
      Prefix: 'custom-resource-responses/cdkd-1',
      Expiration: { Days: 1 },
      NoncurrentVersionExpiration: { NoncurrentDays: 1 },
    });
    expect(rules?.[1]).not.toHaveProperty('Filter');
  });

  it('NEVER writes when the GET fails for any reason other than NoSuchLifecycleConfiguration', async () => {
    // A configuration that could not be read cannot be merged: a PUT here
    // would delete every rule the user has.
    const { client, send } = fakeS3(async () => {
      throw accessDenied();
    });

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.reason).toContain(
      'GetBucketLifecycleConfiguration failed'
    );
    expect(puts(send)).toHaveLength(0);
  });

  it('REFUSES when a stack keeps its state under the prefix, even on a later page', async () => {
    // `--state-prefix custom-resource-responses` puts state.json at
    // custom-resource-responses/<stack>/<region>/state.json: the rule would
    // expire it. Page 1 is all placeholders (digits sort ahead of letters).
    const { client, send } = fakeS3(
      async () => ({ Rules: structuredClone(USER_RULES) }),
      async () => ({}),
      async (input) =>
        input.ContinuationToken === undefined
          ? {
              Contents: [{ Key: 'custom-resource-responses/cdkd-1-a.json' }],
              IsTruncated: true,
              NextContinuationToken: 'page-2',
            }
          : { CommonPrefixes: [{ Prefix: 'custom-resource-responses/cdkd-1My%2BStack/' }] }
    );

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome.status).toBe('refused');
    expect(outcome.status === 'refused' && outcome.reason).toContain('cdkd-1My+Stack/');
    expect(puts(send)).toHaveLength(0);
    const lists = send.mock.calls
      .map((c) => c[0] as object)
      .filter((c): c is ListObjectsV2Command => c instanceof ListObjectsV2Command);
    expect(lists).toHaveLength(2);
    // Scoped to what the rule's filter matches: a state under
    // custom-resource-responses/MyStack/ is out of the rule's reach and must
    // not block it.
    expect(lists[0]?.input).toMatchObject({
      Bucket: BUCKET,
      Prefix: 'custom-resource-responses/cdkd-1',
      Delimiter: '/',
      EncodingType: 'url',
    });
    expect(lists[1]?.input.ContinuationToken).toBe('page-2');
  });

  it('writes nothing when the prefix cannot be listed', async () => {
    const { client, send } = fakeS3(
      async () => ({ Rules: [] }),
      async () => ({}),
      async () => {
        throw accessDenied();
      }
    );

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.reason).toContain('ListObjectsV2 failed');
    expect(puts(send)).toHaveLength(0);
  });

  it('merges onto a SECOND read taken after the listing, so a rule added meanwhile survives', async () => {
    const added: LifecycleRule = { ID: 'added-meanwhile', Status: 'Enabled', Filter: { Prefix: 'y/' } };
    let reads = 0;
    const { client, send } = fakeS3(async () => {
      reads++;
      return reads === 1
        ? { Rules: [structuredClone(USER_RULES[0])] }
        : { Rules: [structuredClone(USER_RULES[0]), added] };
    });

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome).toEqual({ status: 'added' });
    expect(send.mock.calls.map((c) => (c[0] as object).constructor.name)).toEqual([
      GetBucketLifecycleConfigurationCommand.name,
      ListObjectsV2Command.name,
      GetBucketLifecycleConfigurationCommand.name,
      PutBucketLifecycleConfigurationCommand.name,
    ]);
    expect(puts(send)[0]?.input.LifecycleConfiguration?.Rules).toEqual([
      USER_RULES[0],
      added,
      OUR_RULE_FILTER_FORM,
    ]);
  });

  it('writes NOTHING when the second read fails, never falling back to the first', async () => {
    let reads = 0;
    const { client, send } = fakeS3(async () => {
      reads++;
      if (reads === 1) return { Rules: [structuredClone(USER_RULES[0])] };
      throw Object.assign(new Error('SlowDown'), { name: 'SlowDown' });
    });

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.reason).toContain(
      'GetBucketLifecycleConfiguration failed'
    );
    expect(reads).toBe(2);
    expect(puts(send)).toHaveLength(0);
  });

  it('stops as present when another writer added the rule between the two reads', async () => {
    let reads = 0;
    const { client, send } = fakeS3(async () => {
      reads++;
      return reads === 1 ? { Rules: [] } : { Rules: [OUR_RULE_FILTER_FORM] };
    });

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome).toEqual({ status: 'present' });
    expect(puts(send)).toHaveLength(0);
  });

  it('reports a refused PUT as failed instead of throwing', async () => {
    const { client } = fakeS3(
      async () => ({ Rules: [] }),
      async () => {
        throw accessDenied();
      }
    );

    const outcome = await applyCustomResourceResponseExpiration(client, BUCKET);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' && outcome.reason).toContain(
      'PutBucketLifecycleConfiguration failed'
    );
  });

  it('threads ExpectedBucketOwner into every call when given', async () => {
    const { client, send } = fakeS3(async () => ({ Rules: [] }));

    await applyCustomResourceResponseExpiration(client, BUCKET, {
      expectedBucketOwner: '123456789012',
    });

    expect(send).toHaveBeenCalledTimes(4);
    for (const [command] of send.mock.calls) {
      expect((command as { input: { ExpectedBucketOwner?: string } }).input.ExpectedBucketOwner).toBe(
        '123456789012'
      );
    }
  });
});

describe('ensureCustomResourceResponseExpirationOnce (issue #2353)', () => {
  const log = { warn: vi.fn(), debug: vi.fn() };

  beforeEach(() => {
    ownerParam.value = {};
    resetCustomResourceResponseExpirationMemo();
    log.warn.mockReset();
    log.debug.mockReset();
  });

  it('checks a bucket ONCE per process, however many callers ask, concurrently or later', async () => {
    const { client, send } = fakeS3(async () => ({ Rules: [OUR_RULE_FILTER_FORM] }));

    await Promise.all([
      ensureCustomResourceResponseExpirationOnce(client, BUCKET, log),
      ensureCustomResourceResponseExpirationOnce(client, BUCKET, log),
    ]);
    await ensureCustomResourceResponseExpirationOnce(client, BUCKET, log);

    expect(send).toHaveBeenCalledTimes(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('checks a DIFFERENT bucket separately', async () => {
    const { client, send } = fakeS3(async () => ({ Rules: [OUR_RULE_FILTER_FORM] }));

    await ensureCustomResourceResponseExpirationOnce(client, BUCKET, log);
    await ensureCustomResourceResponseExpirationOnce(client, 'other-state-bucket', log);

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('resolves (never rejects) and warns once, with the remedy, when the permission is missing', async () => {
    const { client, send } = fakeS3(async () => {
      throw accessDenied();
    });

    await expect(
      ensureCustomResourceResponseExpirationOnce(client, BUCKET, log)
    ).resolves.toBeUndefined();
    await ensureCustomResourceResponseExpirationOnce(client, BUCKET, log);

    expect(send).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    const message = log.warn.mock.calls[0]?.[0] as string;
    expect(message).toContain(BUCKET);
    expect(message).toContain('left unchanged');
    expect(message).toContain('s3:GetLifecycleConfiguration');
    expect(message).toContain('s3:PutLifecycleConfiguration');
  });

  it('names the permissions only for AccessDenied, and points at the configuration otherwise', async () => {
    // An InvalidRequest: S3 rejects the merged configuration, e.g. a legacy
    // `Prefix: ""` user rule overlapping cdkd's, or the 1000-rule limit.
    const invalid = fakeS3(
      async () => ({ Rules: [] }),
      async () => {
        throw Object.assign(new Error('Found overlapping prefixes'), {
          name: 'InvalidRequest',
          $metadata: { httpStatusCode: 400 },
        });
      }
    );
    await ensureCustomResourceResponseExpirationOnce(invalid.client, BUCKET, log);
    const invalidMessage = log.warn.mock.calls[0]?.[0] as string;
    expect(invalidMessage).toContain('Found overlapping prefixes');
    expect(invalidMessage).toContain("review the bucket's lifecycle configuration");
    expect(invalidMessage).not.toContain('s3:PutLifecycleConfiguration');

    log.warn.mockReset();
    const denied = fakeS3(async () => {
      throw Object.assign(new Error('Access Denied'), {
        name: 'SomeOtherName',
        $metadata: { httpStatusCode: 403 },
      });
    });
    await ensureCustomResourceResponseExpirationOnce(denied.client, 'second-bucket', log);
    const deniedMessage = log.warn.mock.calls[0]?.[0] as string;
    expect(deniedMessage).toContain('s3:PutLifecycleConfiguration');
    expect(deniedMessage).not.toContain("review the bucket's lifecycle configuration");
  });

  it('warns with the state-prefix remedy, not the permission one, on a refusal', async () => {
    const { client } = fakeS3(
      async () => ({ Rules: [] }),
      async () => ({}),
      async () => ({ CommonPrefixes: [{ Prefix: 'custom-resource-responses/cdkd-1Stack/' }] })
    );

    await ensureCustomResourceResponseExpirationOnce(client, BUCKET, log);

    expect(log.warn).toHaveBeenCalledTimes(1);
    const message = log.warn.mock.calls[0]?.[0] as string;
    expect(message).toContain('--state-prefix');
    expect(message).not.toContain('s3:PutLifecycleConfiguration');
  });

  it('resolves, with one warning, when the client throws synchronously', async () => {
    const client = {
      send: () => {
        throw new Error('boom');
      },
    } as unknown as S3Client;

    await expect(
      ensureCustomResourceResponseExpirationOnce(client, BUCKET, log)
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('carries the resolved ExpectedBucketOwner on every deploy-path call', async () => {
    ownerParam.value = { ExpectedBucketOwner: '123456789012' };
    const { client, send } = fakeS3(async () => ({ Rules: [] }));

    await ensureCustomResourceResponseExpirationOnce(client, BUCKET, log);

    expect(send).toHaveBeenCalledTimes(4);
    for (const [command] of send.mock.calls) {
      expect(
        (command as { input: { ExpectedBucketOwner?: string } }).input.ExpectedBucketOwner
      ).toBe('123456789012');
    }
  });

  it('logs the debug line the integ fixture greps when it ADDS the rule, and only then', async () => {
    const { client } = fakeS3(async () => ({ Rules: [] }));
    await ensureCustomResourceResponseExpirationOnce(client, BUCKET, log);
    expect(log.debug).toHaveBeenCalledWith(
      expect.stringContaining('Added the 1-day expiration lifecycle rule for custom-resource-responses/')
    );

    log.debug.mockReset();
    const present = fakeS3(async () => ({ Rules: [OUR_RULE_FILTER_FORM] }));
    await ensureCustomResourceResponseExpirationOnce(present.client, 'second-bucket', log);
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
