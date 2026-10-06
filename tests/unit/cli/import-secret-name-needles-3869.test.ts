/**
 * `cdkd import` masks a physical name derived from a secret on its resolver's
 * lines (go-to-k/cdkd#3869). Its property walk resolves each record against
 * the stack's state, so a `Ref` to a resource whose recorded name is a
 * secret's (here held as the mask, `***`, which needs no fetch) printed the
 * name. The read goes to a print-only sink, never the per-resource bag that
 * decides what import persists.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const debugLines: string[] = [];
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: (...args: unknown[]) => void debugLines.push(args.map(String).join(' ')),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const { resolveImportedProperties } = await import('../../../src/cli/commands/import.js');
const { IntrinsicFunctionResolver } = await import(
  '../../../src/deployment/intrinsic-function-resolver.js'
);
const { hasMaskableValues } = await import('../../../src/deployment/secret-redaction.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const USER_ID = 'team-secret-import-user';

function stateWith(userName: string): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'import-3869',
    region: 'us-east-1',
    resources: {
      User: {
        physicalId: USER_ID,
        resourceType: 'AWS::IAM::User',
        properties: { UserName: userName },
      },
      Key: {
        physicalId: 'AKIAEXAMPLEKEY',
        resourceType: 'AWS::IAM::AccessKey',
        properties: { UserName: { Ref: 'User' } },
      },
    },
    outputs: {},
    lastModified: 0,
  } satisfies StackState;
}

const TEMPLATE = {
  Resources: {
    User: { Type: 'AWS::IAM::User', Properties: {} },
    Key: { Type: 'AWS::IAM::AccessKey', Properties: { UserName: { Ref: 'User' } } },
  },
} as CloudFormationTemplate;

async function importLines(userName: string): Promise<{ lines: string; keyUser: unknown }> {
  debugLines.length = 0;
  const state = stateWith(userName);
  await resolveImportedProperties(state, TEMPLATE, 'us-east-1', {} as never, getLogger());
  return {
    lines: debugLines.join('\n'),
    keyUser: (state.resources['Key']!.properties as Record<string, unknown>)['UserName'],
  };
}

describe('cdkd import masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  it("masks a Ref to a secret-named resource on the resolver's line, and records the real value", async () => {
    const { lines, keyUser } = await importLines('***');
    expect(lines).toContain('Ref to resource: User resolved to');
    expect(lines).not.toContain(USER_ID);
    // What import persists is the real reference value: the needle is print-only.
    expect(keyUser).toBe(USER_ID);
  });

  it('records the read into its print-only sink, never the per-resource bag import persists with', async () => {
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
      const { lines } = await importLines('***');
      expect(lines).toContain('Ref to resource: User resolved to');
    } finally {
      spy.mockRestore();
    }
    expect(bags.length).toBeGreaterThan(0);
    for (const bag of bags) expect(hasMaskableValues(bag)).toBe(false);
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const { lines } = await importLines('plain-user-name');
    expect(lines).toContain(USER_ID);
  });
});
