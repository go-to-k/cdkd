import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * The PROSE half of the SSM parameter, S3 bucket and log group provider
 * messages (issue [#3269](https://github.com/go-to-k/cdkd/issues/3269)).
 *
 * Issues #2669 / #3136 made the pasteable COMMAND in five of these messages safe, but
 * each message also names the same value in PROSE, and that copy was still
 * interpolated raw. `ConsoleLogger.formatMessage` sanitizes only the extra
 * ARGUMENTS, never the message string, so a terminal-control byte, `U+0085`, a
 * Unicode line terminator or a bidi override in a resolved property value
 * reached the operator's terminal in the same line as the hardened command.
 *
 * The unit is the interpolated VALUE, sanitized at the site with
 * `displaySafe`, and where a masker is in scope it is applied FIRST:
 * `displaySafe` rewrites characters, so a secret carrying one would no longer
 * occur literally for the message-level mask to find.
 *
 * Every case pins both directions: the forging characters are absent AND the
 * sanitized value is still there (a message that dropped the name would pass
 * the first half alone), and a clean value renders byte-identically.
 */

const { mockSend, clientRegion, logSpy, ssmRegionFails } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  clientRegion: { value: 'eu-west-1' },
  logSpy: vi.fn(),
  // Makes the SSM client's region resolver reject, which is how the Arn
  // attribute build degrades into its warning.
  ssmRegionFails: { value: false },
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: {
      send: mockSend,
      config: {
        region: () =>
          ssmRegionFails.value
            ? Promise.reject(new Error('region resolver failed'))
            : Promise.resolve(clientRegion.value),
      },
    },
    s3: { send: mockSend, config: { region: () => Promise.resolve(clientRegion.value) } },
    cloudWatchLogs: {
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion.value) },
    },
    sts: { send: () => Promise.resolve({ Account: '111122223333' }) },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  // One spy for every level: a site that moves between debug and warn must
  // not slip out of the assertions below.
  const childLogger = {
    debug: logSpy,
    info: logSpy,
    warn: logSpy,
    error: logSpy,
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: logSpy,
      info: logSpy,
      warn: logSpy,
      error: logSpy,
    }),
  };
});

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { S3BucketProvider } from '../../../src/provisioning/providers/s3-bucket-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import type { MaskerFn } from '../../../src/provisioning/masked-retry-logger.js';

/** Every line the providers logged, joined. */
const logged = (): string => logSpy.mock.calls.map((c) => String(c[0])).join('\n');

// BUILT rather than written as escapes: the formatter rewrites a backslash-u
// escape into the raw byte, which the repo's source-control-bytes fence refuses.
const ESC = String.fromCharCode(0x1b);
const NEL = String.fromCharCode(0x85);
const LINE_SEP = String.fromCharCode(0x2028);
const RLO = String.fromCharCode(0x202e);
const FORGERS = [ESC, NEL, LINE_SEP, RLO] as const;

/** A value carrying every forging class, and what `displaySafe` renders it as. */
const HOSTILE = `a${ESC}[2Kb${NEL}c${LINE_SEP}d${RLO}e`;
const HOSTILE_SHOWN = 'a [2Kb c d e';

function expectNoForgers(text: string): void {
  for (const ch of FORGERS) {
    expect(text).not.toContain(ch);
  }
}

describe('provider prose renders resolved values display-safe (#3269)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    vi.clearAllMocks();
    clientRegion.value = 'eu-west-1';
    ssmRegionFails.value = false;
  });

  describe('SSMParameterProvider partial-create cleanup', () => {
    const run = async (name: string, maskSecrets?: MaskerFn): Promise<void> => {
      mockSend.mockResolvedValueOnce({}); // PutParameter
      mockSend.mockRejectedValueOnce(new Error('AddTags boom')); // AddTagsToResource
      mockSend.mockRejectedValueOnce(new Error('DeleteParameter also failed')); // cleanup
      await expect(
        new SSMParameterProvider().create(
          'MyParam',
          'AWS::SSM::Parameter',
          { Name: name, Type: 'String', Value: 'v', Tags: [{ Key: 'k', Value: 'v' }] },
          maskSecrets ? { maskSecrets } : undefined
        )
      ).rejects.toThrow('AddTags boom');
    };

    it('sanitizes the prose name, keeping it in the line', async () => {
      await run(`/cdkd/${HOSTILE}`);
      expectNoForgers(logged());
      expect(logged()).toContain(
        `Failed to clean up partially-created SSM parameter MyParam (/cdkd/${HOSTILE_SHOWN})`
      );
    });

    it('renders a clean name byte-identically', async () => {
      await run('/cdkd/clean');
      expect(logged()).toContain(
        'Failed to clean up partially-created SSM parameter MyParam (/cdkd/clean)'
      );
    });

    it('masks BEFORE sanitizing, so a secret carrying a rewritten character stays masked', async () => {
      // The masker matches the LITERAL secret, which includes the NEL. Sanitize
      // first and the text holds `s3cr et`, which the masker no longer matches.
      const secret = `s3cr${NEL}et`;
      await run(`/cdkd/${secret}`, (t) => t.split(secret).join('<redacted>'));
      expect(logged()).not.toContain('s3cr');
      expect(logged()).toContain('(/cdkd/<redacted>)');
    });
  });

  describe('SSMParameterProvider mask-before-sanitize at every create / update site', () => {
    // A secret carrying a character `displaySafe` rewrites is the only input
    // that tells mask-then-sanitize from sanitize-then-mask, so each line that
    // renders the name is driven with one.
    const secret = `s3cr${NEL}et`;
    const masker: MaskerFn = (t) => t.split(secret).join('<redacted>');

    it('create: the success line and the Arn-attribute warning', async () => {
      ssmRegionFails.value = true;
      mockSend.mockResolvedValue({});
      await new SSMParameterProvider().create(
        'MyParam',
        'AWS::SSM::Parameter',
        { Name: `/cdkd/${secret}`, Type: 'String', Value: 'v' },
        { maskSecrets: masker }
      );
      expect(logged()).toContain('Could not build the Arn attribute for SSM parameter /cdkd/<redacted>');
      expect(logged()).toContain('Successfully created SSM parameter MyParam: /cdkd/<redacted>');
      expect(logged()).not.toContain('s3cr');
    });

    it('create: the cleaned-up line', async () => {
      mockSend.mockResolvedValueOnce({}); // PutParameter
      mockSend.mockRejectedValueOnce(new Error('AddTags boom'));
      mockSend.mockResolvedValueOnce({}); // cleanup succeeds
      await expect(
        new SSMParameterProvider().create(
          'MyParam',
          'AWS::SSM::Parameter',
          { Name: `/cdkd/${secret}`, Type: 'String', Value: 'v', Tags: [{ Key: 'k', Value: 'v' }] },
          { maskSecrets: masker }
        )
      ).rejects.toThrow('AddTags boom');
      expect(logged()).toContain('Cleaned up partially-created SSM parameter MyParam (/cdkd/<redacted>)');
      expect(logged()).not.toContain('s3cr');
    });

    it('update: the updating and tag lines', async () => {
      mockSend.mockResolvedValue({});
      await new SSMParameterProvider().update(
        'MyParam',
        `/cdkd/${secret}`,
        'AWS::SSM::Parameter',
        { Name: `/cdkd/${secret}`, Type: 'String', Value: 'v2', Tags: { k: 'v2' } },
        { Name: `/cdkd/${secret}`, Type: 'String', Value: 'v', Tags: { k: 'v' } },
        { maskSecrets: masker }
      );
      expect(logged()).toContain('Updating SSM parameter MyParam: /cdkd/<redacted>');
      expect(logged()).toContain('Updated tags for SSM parameter /cdkd/<redacted>');
      expect(logged()).not.toContain('s3cr');
    });
  });

  describe('SSMParameterProvider import refusal', () => {
    const refusal = async (explicit: string): Promise<string> => {
      try {
        await new SSMParameterProvider().import({
          logicalId: 'MyParam',
          resourceType: 'AWS::SSM::Parameter',
          stackName: 'MyStack',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: explicit,
        });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('import() did not refuse the unwritable physical id');
    };

    it('sanitizes the quoted prose value', async () => {
      const message = await refusal(`arn:aws:ssm:us-east-1:111122223333:parameter/${HOSTILE}`);
      expectNoForgers(message);
      expect(message).toContain(`('arn:aws:ssm:us-east-1:111122223333:parameter/${HOSTILE_SHOWN}')`);
    });

    it('renders a clean value byte-identically', async () => {
      const arn = 'arn:aws:ssm:us-east-1:111122223333:parameter/clean';
      expect(await refusal(arn)).toContain(`('${arn}')`);
    });
  });

  describe('SSMParameterProvider sibling sites', () => {
    it('sanitizes the physical id on the delete path', async () => {
      const { ParameterNotFound } = await import('@aws-sdk/client-ssm');
      mockSend.mockRejectedValueOnce(
        new ParameterNotFound({ message: 'gone', $metadata: {} })
      );
      await new SSMParameterProvider().delete(
        `Logical${HOSTILE}`,
        `/cdkd/${HOSTILE}`,
        'AWS::SSM::Parameter'
      );
      expectNoForgers(logged());
      expect(logged()).toContain(`Parameter /cdkd/${HOSTILE_SHOWN} does not exist`);
      expect(logged()).toContain(`Deleting SSM parameter Logical${HOSTILE_SHOWN}:`);
    });
  });

  describe('S3BucketProvider partial-create cleanup, both arms', () => {
    const runFailedCleanup = async (bucketName: string, maskSecrets?: MaskerFn): Promise<void> => {
      clientRegion.value = 'eu-west-1';
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));
      mockSend.mockRejectedValueOnce(new Error('DeleteBucket also failed'));
      await expect(
        new S3BucketProvider().create(
          'MyBucket',
          'AWS::S3::Bucket',
          { BucketName: bucketName, VersioningConfiguration: { Status: 'Enabled' } },
          maskSecrets ? { maskSecrets } : undefined
        )
      ).rejects.toThrow('applyConfiguration boom');
    };

    const runIndeterminate = async (bucketName: string, maskSecrets?: MaskerFn): Promise<void> => {
      clientRegion.value = 'us-east-1';
      const denied = new Error('Access Denied');
      Object.assign(denied, { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      mockSend.mockRejectedValueOnce(denied); // GetBucketLocation pre-flight
      mockSend.mockResolvedValueOnce({}); // CreateBucket
      mockSend.mockRejectedValueOnce(new Error('applyConfiguration boom'));
      await expect(
        new S3BucketProvider().create(
          'MyBucket',
          'AWS::S3::Bucket',
          { BucketName: bucketName, VersioningConfiguration: { Status: 'Enabled' } },
          maskSecrets ? { maskSecrets } : undefined
        )
      ).rejects.toThrow('Failed to create S3 bucket');
    };

    const ARMS = [
      ['cleanup-failed', runFailedCleanup, 'Failed to clean up partially-created S3 bucket'],
      ['indeterminate-probe', runIndeterminate, 'Not cleaning up S3 bucket'],
    ] as const;

    for (const [label, run, lead] of ARMS) {
      it(`${label} arm sanitizes the prose bucket name`, async () => {
        await run(`cdkd-${HOSTILE}`);
        expectNoForgers(logged());
        expect(logged()).toContain(`${lead} MyBucket (cdkd-${HOSTILE_SHOWN})`);
      });

      it(`${label} arm renders a clean bucket name byte-identically`, async () => {
        await run('cdkd-clean');
        expect(logged()).toContain(`${lead} MyBucket (cdkd-clean)`);
      });

      it(`${label} arm masks BEFORE sanitizing`, async () => {
        const secret = `s3cr${NEL}et`;
        await run(`cdkd-${secret}`, (t) => t.split(secret).join('<redacted>'));
        const warnLine = logged()
          .split('\n')
          .find((l) => l.startsWith(lead));
        expect(warnLine).toBeDefined();
        expect(warnLine).not.toContain('s3cr');
        expect(warnLine).toContain('(cdkd-<redacted>)');
      });
    }
  });

  describe('S3BucketProvider sibling sites', () => {
    it('sanitizes the lifecycle rule id and bucket name in the delete-marker warning', async () => {
      mockSend.mockResolvedValue({});
      const provider = new S3BucketProvider() as unknown as {
        applyLifecycleConfiguration(
          bucketName: string,
          config: { Rules: Array<Record<string, unknown>> }
        ): Promise<boolean>;
      };
      await provider.applyLifecycleConfiguration(`cdkd-${HOSTILE}`, {
        Rules: [
          {
            Id: `rule-${HOSTILE}`,
            Status: 'Enabled',
            ExpiredObjectDeleteMarker: true,
            ExpirationInDays: 30,
          },
        ],
      });
      expectNoForgers(logged());
      expect(logged()).toContain(
        `Lifecycle rule 'rule-${HOSTILE_SHOWN}' on cdkd-${HOSTILE_SHOWN} sets ExpiredObjectDeleteMarker`
      );
    });

    it.each([
      [
        'noncurrent-version',
        {
          NoncurrentVersionTransitions: [{ StorageClass: `GLACIER${NEL}`, TransitionInDays: 30 }],
          NoncurrentVersionTransition: { StorageClass: `GLACIER${NEL}`, TransitionInDays: 60 },
        },
        'both NoncurrentVersionTransitions and the legacy NoncurrentVersionTransition',
      ],
      [
        'current-version',
        {
          Transitions: [{ StorageClass: `GLACIER${NEL}`, TransitionInDays: 30 }],
          Transition: { StorageClass: `GLACIER${NEL}`, TransitionInDays: 60 },
        },
        'both Transitions and the legacy Transition',
      ],
    ])(
      'sanitizes the rule id, bucket name and storage class in the %s legacy-singular warning',
      async (_label, transitions, phrase) => {
        mockSend.mockResolvedValue({});
        const provider = new S3BucketProvider() as unknown as {
          applyLifecycleConfiguration(
            bucketName: string,
            config: { Rules: Array<Record<string, unknown>> }
          ): Promise<boolean>;
        };
        await provider.applyLifecycleConfiguration(`cdkd-${HOSTILE}`, {
          Rules: [{ Id: `rule-${HOSTILE}`, Status: 'Enabled', ...transitions }],
        });
        expectNoForgers(logged());
        expect(logged()).toContain(
          `Lifecycle rule 'rule-${HOSTILE_SHOWN}' on cdkd-${HOSTILE_SHOWN} declares ${phrase} for storage class GLACIER;`
        );
      }
    );

    it('sanitizes a malformed destination value named in a refusal', async () => {
      // `JSON.stringify` escapes C0 but passes NEL, the line separators and the
      // bidi overrides through verbatim, so it is not a terminal-safety boundary.
      const provider = new S3BucketProvider() as unknown as {
        resolveS3BucketDestination(dest: unknown, destinationPath: string): unknown;
      };
      let message = '';
      try {
        provider.resolveS3BucketDestination(`x${NEL}y${LINE_SEP}z${RLO}w`, 'Dest');
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('Dest must be an object (got a string "x y z w")');
      expectNoForgers(message);
    });

    it('masks a destination object KEY before sanitizing it', async () => {
      const secret = `s3cr${LINE_SEP}et`;
      const provider = new S3BucketProvider() as unknown as {
        resolveS3BucketDestination(
          dest: unknown,
          destinationPath: string,
          onUnusable: undefined,
          maskSecrets: MaskerFn
        ): unknown;
      };
      let message = '';
      try {
        provider.resolveS3BucketDestination({ [secret]: 1 }, 'Dest', undefined, (t) =>
          t.split(secret).join('<redacted>')
        );
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain('keys [<redacted>]');
      expect(message).not.toContain('s3cr');
    });
  });
  describe('LogsLogGroupProvider partial-create cleanup', () => {
    // The fifth hardened-command-beside-raw-prose site, missed by the issue's
    // list of four: the same shape, one provider over.
    const LEAD = 'Failed to clean up partially-created log group';
    const COMMAND = 'aws logs delete-log-group --log-group-name';
    const run = async (name: string, maskSecrets?: MaskerFn): Promise<void> => {
      mockSend.mockResolvedValueOnce({}); // CreateLogGroup
      mockSend.mockRejectedValueOnce(new Error('PutRetentionPolicy boom'));
      mockSend.mockRejectedValueOnce(new Error('DeleteLogGroup also failed'));
      await expect(
        new LogsLogGroupProvider().create(
          'MyLG',
          'AWS::Logs::LogGroup',
          { LogGroupName: name, RetentionInDays: 7 },
          maskSecrets ? { maskSecrets } : undefined
        )
      ).rejects.toThrow('Failed to create log group');
    };

    it('sanitizes the prose log group name', async () => {
      await run(`/cdkd/${HOSTILE}`);
      expectNoForgers(logged());
      expect(logged()).toContain(`${LEAD} MyLG (/cdkd/${HOSTILE_SHOWN})`);
    });

    it('renders a clean name byte-identically, command included', async () => {
      await run('/cdkd/clean');
      expect(logged()).toContain(`${LEAD} MyLG (/cdkd/clean)`);
      expect(logged()).toContain(`${COMMAND} /cdkd/clean`);
    });

    it('masks the whole warning, and masks the prose name BEFORE sanitizing', async () => {
      const secret = `s3cr${NEL}et`;
      await run(`/cdkd/${secret}`, (t) => t.split(secret).join('<redacted>'));
      expect(logged()).not.toContain('s3cr');
      expect(logged()).toContain(`${LEAD} MyLG (/cdkd/<redacted>)`);
    });

    it("masks AWS's own cleanup-failure text, which can quote the name back", async () => {
      mockSend.mockResolvedValueOnce({}); // CreateLogGroup
      mockSend.mockRejectedValueOnce(new Error('PutRetentionPolicy boom'));
      mockSend.mockRejectedValueOnce(new Error('Log group /cdkd/s3cr3t is busy'));
      await expect(
        new LogsLogGroupProvider().create(
          'MyLG',
          'AWS::Logs::LogGroup',
          { LogGroupName: '/cdkd/s3cr3t', RetentionInDays: 7 },
          { maskSecrets: (t) => t.replace(/s3cr3t/g, '<redacted>') }
        )
      ).rejects.toThrow('Failed to create log group');
      const warnLine = logged()
        .split('\n')
        .find((l) => l.startsWith(LEAD));
      expect(warnLine).toContain('Log group /cdkd/<redacted> is busy');
      expect(warnLine).not.toContain('s3cr3t');
    });

    it('suppresses the command for a secret-bearing name the quoting would split', async () => {
      // `shellQuote` rewrites an inner quote to an escaped run, so the secret no
      // longer OCCURS in the command for a message-level mask to find; the
      // masker threaded into the renderer suppresses the command instead.
      await run("/cdkd/o'brien-s3cr3t", (t) => t.replace(/s3cr3t/g, '<redacted>'));
      expect(logged()).not.toContain('s3cr3t');
      expect(logged()).not.toContain(COMMAND);
      expect(logged()).toContain('via the console');
      expect(logged()).toContain("(/cdkd/o'brien-<redacted>)");
    });
  });
});
