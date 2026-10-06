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
    outputs: {},
    lastModified: 0,
  };
}

async function scrubLines(userName: string): Promise<string> {
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
  await scrubStack(stackInfo() as never, 'us-east-1', stateBackend as never, lockManager as never, {
    dryRun: true,
    logger: getLogger(),
  });
  return logLines.join('\n');
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

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await scrubLines('plain-user-name');
    expect(lines).toContain(USER_ID);
  });
});
