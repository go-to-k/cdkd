/**
 * go-to-k/cdkd#7154: `cdkd scrub` puts a list leaf back on ITS OWN template
 * expression when a twin reference shares its plaintext, instead of the one
 * expression the value scan's plaintext-keyed map holds.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { redactForState, type RecordedSecretValues } from '../../../../src/deployment/secret-redaction.js';
import { recordResolvedPair } from '../../../../src/deployment/secret-redaction/pairs.js';
import { positionTwinReferences } from '../../../../src/cli/commands/scrub/twin-references.js';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const PLAIN = 'tw1n-7154-pl4intext';

vi.mock('../../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...child, setLevel: vi.fn(), child: () => child }) };
});
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ssm: { send: vi.fn(() => Promise.resolve({ Parameter: { Value: PLAIN, Type: 'SecureString' } })) },
  }),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';
const OWN = '{{resolve:ssm-secure:/app/own}}';
const TWIN = '{{resolve:ssm-secure:/app/twin}}';

/** The pass map as the resolver leaves it: TWIN recorded last, so it holds the slot. */
function passSecrets(): RecordedSecretValues {
  const secrets: RecordedSecretValues = new Map();
  secrets.set(PLAIN, OWN);
  recordResolvedPair(secrets, OWN, PLAIN);
  secrets.set(PLAIN, TWIN);
  recordResolvedPair(secrets, TWIN, PLAIN);
  return secrets;
}

/** The scrub's two steps: the `template-sourced` positioning, then the twin pass. */
function scrubbed(stored: Record<string, unknown>, template: Record<string, unknown>, secrets: RecordedSecretValues): unknown {
  const positioned = redactForState(stored, { provenance: 'template-sourced', secrets, source: template, generation: 'unproven' });
  return positionTwinReferences(stored, positioned, template, secrets);
}

describe('scrub twin references (go-to-k/cdkd#7154)', () => {
  it('positions a list leaf on its own expression, not the twin holding the map slot', () => {
    const secrets = passSecrets();
    const template = { Users: [{ Password: OWN }, { Password: `pre-${OWN}-post` }], Other: TWIN };
    const stored = { Users: [{ Password: PLAIN }, { Password: `pre-${PLAIN}-post` }], Other: PLAIN };
    // Without this pass the value scan writes TWIN into the list (the bug).
    const positioned = redactForState(stored, { provenance: 'template-sourced', secrets, source: template, generation: 'unproven' });
    expect(JSON.stringify(positioned)).not.toContain(PLAIN);
    expect(positioned).not.toEqual(template);
    const out = scrubbed(stored, template, secrets);
    expect(out).toEqual(template);
    expect(JSON.stringify(out)).not.toContain(PLAIN);
  });

  it('keeps the masked leaf when the pairing is not proven', () => {
    const secrets = passSecrets();
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      // Lists of different lengths: no index pairing.
      ['lengths differ', { L: [OWN] }, { L: [PLAIN, PLAIN] }],
      // An edited template whose text resolves to something else.
      ['edited template', { L: [`x-${OWN}`] }, { L: [`y-${PLAIN}`] }],
      // A stored leaf that already holds an expression (issue #1917).
      ['already an expression', { L: [OWN] }, { L: [TWIN] }],
      // A template literal around the token holding the plaintext.
      ['literal holds the plaintext', { L: [`${PLAIN}${OWN}`] }, { L: [`${PLAIN}${PLAIN}`] }],
      // A token this pass never resolved.
      ['unresolved token', { L: ['{{resolve:ssm-secure:/app/never}}'] }, { L: [PLAIN] }],
      // No token at all: a literal equal to the plaintext is never written back.
      ['no token', { L: [PLAIN] }, { L: [PLAIN] }],
    ];
    for (const [name, template, stored] of cases) {
      const positioned = redactForState(stored, { provenance: 'template-sourced', secrets, source: template, generation: 'unproven' });
      const out = positionTwinReferences(stored, positioned, template, secrets);
      expect(out, name).toBe(positioned);
      expect(JSON.stringify(out), name).not.toContain(PLAIN);
    }
  });

  it('never pairs a reordered list by index, keyed by Name or not', () => {
    const secrets = passSecrets();
    for (const field of ['Name', 'Label']) {
      const template = { L: [{ [field]: 'a', Value: OWN }, { [field]: 'b', Value: TWIN }] };
      const stored = { L: [{ [field]: 'b', Value: PLAIN }, { [field]: 'a', Value: PLAIN }] };
      const positioned = redactForState(stored, { provenance: 'template-sourced', secrets, source: template, generation: 'unproven' });
      expect(positionTwinReferences(stored, positioned, template, secrets), field).toBe(positioned);
    }
  });

  it('keeps a null-prototype bag null-prototype, and a __proto__ key a key', () => {
    const secrets = passSecrets();
    const template = JSON.parse(`{"__proto__": [{"V": "x"}, {"V": "${OWN}"}]}`) as Record<string, unknown>;
    const stored = JSON.parse(`{"__proto__": [{"V": "x"}, {"V": "${PLAIN}"}]}`) as Record<string, unknown>;
    const positioned = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(positioned, '__proto__', { value: [{ V: 'x' }, { V: TWIN }], enumerable: true, writable: true, configurable: true });
    const out = positionTwinReferences(stored, positioned, template, secrets) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBeNull();
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(JSON.stringify(out)).toBe(JSON.stringify(template));
  });

  it('keeps the masked leaf when the token resolved to a plaintext the map does not hold', () => {
    // A map the resolver did not populate this way: the pair survives, the entry does not.
    const secrets = passSecrets();
    recordResolvedPair(secrets, '{{resolve:ssm-secure:/app/gone}}', 'g0ne-7154-value');
    const template = { L: ['{{resolve:ssm-secure:/app/gone}}'] };
    const stored = { L: ['g0ne-7154-value'] };
    const positioned = { L: ['***'] };
    expect(positionTwinReferences(stored, positioned, template, secrets)).toBe(positioned);
  });

  it('keeps the masked leaf when the template token resolved to two values this pass', () => {
    const secrets = passSecrets();
    recordResolvedPair(secrets, OWN, 'another-value-7154');
    const template = { L: [OWN] };
    const stored = { L: [PLAIN] };
    const positioned = redactForState(stored, { provenance: 'template-sourced', secrets, source: template, generation: 'unproven' });
    expect(positionTwinReferences(stored, positioned, template, secrets)).toBe(positioned);
  });

  // Either order: whichever reference the resolver records last holds the map slot.
  it.each([
    ['the twin first', true],
    ['the twin last', false],
  ])('cdkd scrub writes each twin its own expression, %s', async (_name, twinFirst) => {
    // Elements with no identity field (`Name` / `Key`), which the walk could pair by.
    const list = [{ Image: 'plain-7154' }, { RepositoryCredentials: { CredentialsParameter: OWN } }];
    const properties = twinFirst ? { Family: TWIN, ContainerDefinitions: list } : { ContainerDefinitions: list, Family: TWIN };
    const template = {
      Resources: { Task: { Type: 'AWS::ECS::TaskDefinition', Properties: properties } },
      Outputs: {},
    } as unknown as CloudFormationTemplate;
    const stored = {
      ContainerDefinitions: [{ Image: 'plain-7154' }, { RepositoryCredentials: { CredentialsParameter: PLAIN } }],
      Family: PLAIN,
    };
    const state = {
      version: 11,
      region: 'us-east-1',
      stackName: 'S',
      resources: {
        Task: { physicalId: 'arn:task', resourceType: 'AWS::ECS::TaskDefinition', properties: stored, attributes: {}, dependencies: [] },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const saveState = vi.fn().mockResolvedValue('etag-2');
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    await scrubStack(
      { stackName: 'S', template } as never,
      'us-east-1',
      {
        getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
        saveState,
        purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
        listStacks: vi.fn().mockResolvedValue([]),
      } as never,
      { acquireLockWithRetry: vi.fn().mockResolvedValue(undefined), releaseLock: vi.fn().mockResolvedValue(undefined) } as never,
      { dryRun: false, logger } as never
    );
    const saved = saveState.mock.calls.at(-1)?.[2] as StackState | undefined;
    expect(saved).toBeDefined();
    expect(JSON.stringify(saved)).not.toContain(PLAIN);
    expect(saved!.resources.Task!.properties).toEqual(properties);
  });
});
