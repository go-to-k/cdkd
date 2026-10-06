/**
 * `cdkd scrub` masks a physical name derived from a secret on its resolver's
 * lines (go-to-k/cdkd#3869). Scrub resolves every template property against
 * state, so a `Ref` to a resource whose recorded name is a secret's printed
 * the name. The read goes to a print-only sink; each resource's own bag,
 * which positions what scrub persists, is untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const logLines: string[] = [];
vi.mock('../../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void =>
      void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

const { scrubStack } = await import('../../../../src/cli/commands/scrub.js');
const { getLogger } = await import('../../../../src/utils/logger.js');
const { IntrinsicFunctionResolver } = await import(
  '../../../../src/deployment/intrinsic-function-resolver.js'
);
const { hasMaskableValues } = await import('../../../../src/deployment/secret-redaction.js');

const USER_ID = 'team-secret-scrub-user';

function stackInfo() {
  return {
    stackName: 'Scrub3869',
    displayName: 'Scrub3869',
    artifactId: 'Scrub3869',
    dependencyNames: [],
    template: {
      Resources: {
        User: { Type: 'AWS::IAM::User', Properties: { UserName: 'from-a-secret' } },
        Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: { Ref: 'User' } } },
      },
      Outputs: { KeyUser: { Value: { 'Fn::Sub': 'user=${User}' } } },
    } as CloudFormationTemplate,
  };
}

function stateWith(userName: string) {
  return {
    version: 9,
    stackName: 'Scrub3869',
    region: 'us-east-1',
    resources: {
      User: {
        physicalId: USER_ID,
        resourceType: 'AWS::IAM::User',
        properties: { UserName: userName },
        attributes: {},
        dependencies: [],
      },
      Key: {
        physicalId: 'AKIAEXAMPLEKEY',
        resourceType: 'AWS::IAM::AccessKey',
        properties: { UserName: USER_ID },
        attributes: {},
        dependencies: ['User'],
      },
    },
    outputs: { KeyUser: `user=${USER_ID}` },
    lastModified: 0,
  };
}

async function scrubRun(userName: string): Promise<{
  lines: string;
  result: { recordsChanged: number; secretsFound: number; secretBearingKeys: number };
}> {
  logLines.length = 0;
  const stateBackend = {
    getState: vi.fn().mockResolvedValue({ state: stateWith(userName), etag: 'etag-1' }),
    saveState: vi.fn().mockResolvedValue('etag-2'),
    purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
  };
  const lockManager = {
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  };
  const result = await scrubStack(
    stackInfo() as never,
    'us-east-1',
    stateBackend as never,
    lockManager as never,
    { dryRun: true, logger: getLogger() }
  );
  return { lines: logLines.join('\n'), result };
}

async function scrubLines(userName: string): Promise<string> {
  return (await scrubRun(userName)).lines;
}

describe('cdkd scrub masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  beforeEach(() => {
    logLines.length = 0;
  });

  it("masks a Ref to a secret-named resource on the resolver's line", async () => {
    const lines = await scrubLines('{{resolve:secretsmanager:team:SecretString:user::}}');
    expect(lines).toContain('Ref to resource: User resolved to');
    expect(lines).not.toContain(USER_ID);
  });

  it('masks an output reading the secret-named resource, and finds no secret to scrub', async () => {
    const { lines, result } = await scrubRun('{{resolve:secretsmanager:team:SecretString:user::}}');
    // Premise: the output's read was resolved and printed.
    expect(lines.split('\n').filter((l) => l.includes('Ref to resource: User resolved to')).length).toBeGreaterThanOrEqual(2);
    expect(lines).not.toContain(USER_ID);
    // A derived name is no secret plaintext: scrub decides nothing from it.
    expect(result).toMatchObject({ recordsChanged: 0, secretsFound: 0 });
  });

  it("records the reads into its print-only sink, never a resource's bag scrub positions with", async () => {
    const bags: Array<Map<string, string>> = [];
    const original = IntrinsicFunctionResolver.prototype.resolve;
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolve')
      .mockImplementation(function (this: unknown, value: unknown, context: unknown) {
        const bag = (context as { recordedSecretValues?: Map<string, string> }).recordedSecretValues;
        if (bag) bags.push(bag);
        return original.call(this as never, value, context as never);
      });
    try {
      const { lines } = await scrubRun('{{resolve:secretsmanager:team:SecretString:user::}}');
      expect(lines).toContain('Ref to resource: User resolved to');
    } finally {
      spy.mockRestore();
    }
    expect(bags.length).toBeGreaterThan(0);
    for (const bag of bags) expect(hasMaskableValues(bag)).toBe(false);
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await scrubLines('plain-user-name');
    expect(lines).toContain(USER_ID);
  });
});
