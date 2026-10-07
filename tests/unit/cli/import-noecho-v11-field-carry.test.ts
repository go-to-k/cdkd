import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { buildStackState } from '../../../src/cli/commands/import.js';
import { TemplateParser } from '../../../src/analyzer/template-parser.js';
import { SECRET_MASK, scrubResourceRecord } from '../../../src/deployment/secret-redaction.js';
import { recordAfterRollbackUpdate } from '../../../src/deployment/rollback-executor/replay-retry.js';
import { deleteReplacedAfterCreate } from '../../../src/deployment/deploy-engine/replacement.js';
import { REDACTED_DELETE_ADDRESS_SKIP_REASON } from '../../../src/provisioning/redacted-delete-address.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { DeployEngine } from '../../../src/deployment/deploy-engine.js';

/**
 * go-to-k/cdkd#4043 / #2449 (schema v11, review M1): a writer that rebuilds a
 * `ResourceState` by an explicit field list must not drop the two v11 fields
 * where it carries a record forward. The writers that SPREAD a record keep
 * them by construction; these cases pin both kinds.
 */
describe('v11 NoEcho fields survive the record writers', () => {
  const template: CloudFormationTemplate = {
    Resources: { Cr: { Type: 'Custom::Thing', Properties: {} } },
  };
  const prior = (physicalId: string): StackState =>
    ({
      version: 11,
      stackName: 'Stack',
      region: 'us-east-1',
      resources: {
        Cr: {
          physicalId,
          resourceType: 'Custom::Thing',
          properties: { Token: SECRET_MASK },
          attributes: { Secret: SECRET_MASK, Plain: 'p' },
          noEchoLeaves: [['Token']],
          noEchoAttributeNames: ['Secret'],
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    }) as StackState;
  const reimport = (physicalId: string, attributes: Record<string, unknown>) =>
    buildStackState(
      'Stack',
      'us-east-1',
      [{ logicalId: 'Cr', resourceType: 'Custom::Thing', outcome: 'imported', physicalId, attributes }],
      new TemplateParser(),
      template,
      prior('cr-1'),
      true
    ).resources['Cr']!;

  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    info = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
  });

  it('cdkd import carries a declared name whose attribute still holds the mask on the same physical id', () => {
    const record = reimport('cr-1', {});
    expect(record.attributes?.['Secret']).toBe(SECRET_MASK);
    expect(record.noEchoAttributeNames).toEqual(['Secret']);
  });

  it('cdkd import drops a declared name whose attribute the re-import replaced with a value', () => {
    expect(reimport('cr-1', { Secret: 'fresh', Plain: 'p' }).noEchoAttributeNames).toBeUndefined();
  });

  it('cdkd import carries nothing onto a different physical id', () => {
    expect(reimport('cr-2', { Secret: SECRET_MASK }).noEchoAttributeNames).toBeUndefined();
  });

  it('cdkd import does not carry noEchoLeaves: it rebuilds properties from the template', () => {
    expect(reimport('cr-1', {}).noEchoLeaves).toBeUndefined();
  });

  it('scrubResourceRecord (deploy, scrub, journal, orphan) spreads both fields through', () => {
    const record = prior('cr-1').resources['Cr']!;
    const scrubbed = scrubResourceRecord({ ...record, properties: { Token: 'x' } }, new Map([['x', '{{resolve:ssm-secure:/p}}']]));
    expect(scrubbed.noEchoLeaves).toEqual([['Token']]);
    expect(scrubbed.noEchoAttributeNames).toEqual(['Secret']);
  });

  it('the rollback replay record rebuild spreads both fields through', () => {
    const record = prior('cr-1').resources['Cr']!;
    const rebuilt = recordAfterRollbackUpdate(record, {
      physicalId: 'cr-1',
      wasReplaced: false,
      attributes: { Plain: 'q' },
    } as Parameters<typeof recordAfterRollbackUpdate>[1]);
    expect(rebuilt.noEchoLeaves).toEqual([['Token']]);
    expect(rebuilt.noEchoAttributeNames).toEqual(['Secret']);
  });
});

/**
 * Review M2: a replacement whose OLD record addresses its delete through a
 * property persisted as `***` (a NoEcho value). The provider skips the delete
 * (`redactedDeleteAddressSkip`); on the create-first replacement the new
 * resource already exists, so the skip WARNS that the old one is untracked and
 * left in AWS, and does not fail the deploy (go-to-k/cdkd#1762).
 */
describe('replacement delete of an old record whose address is the NoEcho mask', () => {
  it('warns that the old resource is left untracked, and does not throw', async () => {
    const lines: string[] = [];
    const engine = {
      stackRegion: 'us-east-1',
      options: {},
      logger: { warn: (m: string) => lines.push(m), info: () => undefined, debug: () => undefined },
      replacementDeleteContext: () => ({}),
    } as unknown as DeployEngine;
    const provider = {
      delete: vi.fn().mockResolvedValue({
        outcome: 'skipped',
        reason: REDACTED_DELETE_ADDRESS_SKIP_REASON,
      }),
    } as unknown as ResourceProvider;
    const old: ResourceState = {
      physicalId: 'old-id',
      resourceType: 'AWS::Lambda::Permission',
      properties: { FunctionName: SECRET_MASK },
      noEchoLeaves: [['FunctionName']],
    };
    await expect(
      deleteReplacedAfterCreate.call(
        engine,
        'Perm',
        'AWS::Lambda::Permission',
        old,
        provider,
        old.properties,
        undefined,
        undefined,
        new Map(),
        'sdk'
      )
    ).resolves.toBeUndefined();
    expect(provider.delete).toHaveBeenCalledTimes(1);
    expect(lines.some((line) => line.includes('it is no longer tracked in state'))).toBe(true);
  });
});
