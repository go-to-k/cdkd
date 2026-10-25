import {
  ACCOUNT,
  DECLARED_DEFAULT,
  TAG_THROWS,
  createOnlyOf,
  paths,
  setOutputOverrides,
  type TypeCase,
} from './sdk-wire-harness.js';
import { IAMUserGroupProvider } from '../../../src/provisioning/providers/iam-user-group-provider.js';
import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';

/**
 * Wire cases for the IAM user / group / user-to-group addition provider and
 * the Secrets Manager secret provider (#3723). Run by
 * `sdk-wire-coverage-iam-secrets.test.ts`, which mocks the clients these
 * providers reach; the ledger in `sdk-wire-coverage.test.ts` counts them as
 * covered.
 */

const POLICY_DOCUMENT = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '*' }],
};

/** `<direction>:<prefix>` and every `<direction>:<prefix>.<path under POLICY_DOCUMENT>`, each with `why`. */
function docSilent(direction: string, prefix: string, why: string): Record<string, string> {
  const under = paths(POLICY_DOCUMENT).map((p) => `${prefix}.${p.join('.')}`);
  return Object.fromEntries([prefix, ...under].map((l) => [`${direction}:${l}`, why]));
}

// Not a gap: every desired inline policy is put again from `next` on each
// update, so a document removed from the recorded side alone changes nothing
// (its update-add probe observes delivery).
const PUT_FROM_NEXT = 'every desired policy is put again from next on each update; prev is not read';

/** A user's or group's inline `Policies.<i>.PolicyDocument` paths, re-put from next. */
const INLINE_POLICY_DOCS_SILENT = {
  ...docSilent('update-remove', 'Policies.0.PolicyDocument', PUT_FROM_NEXT),
  ...docSilent('update-remove', 'Policies.1.PolicyDocument', PUT_FROM_NEXT),
};

/**
 * A deterministic stand-in for `crypto.getRandomValues`, installed by
 * `sdk-wire-coverage-iam-secrets.test.ts`: a generated secret value is drawn locally,
 * so without it every two creates would differ and no probe could be silent.
 * The sequence restarts before each provider call (`armRestartingRandom`), so
 * two calls with the same bag draw the same value.
 */
let randomState = 1;
export function deterministicRandomValues<T extends ArrayBufferView | null>(array: T): T {
  const view = array as unknown as Uint32Array;
  for (let i = 0; i < view.length; i++) {
    randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
    view[i] = randomState;
  }
  return array;
}
function armRestartingRandom(): void {
  randomState = 1;
  setOutputOverrides(undefined);
}

// A secret member REMOVED from the template is not reset: UpdateSecret has
// merge semantics, and CloudFormation keeps the live value on removal
// (secretsmanager-secret-provider.ts update(); go-to-k/cdkd#5004, #1160).
const KEPT_ON_REMOVAL = Object.fromEntries(
  ['Description', 'KmsKeyId', 'Type'].map((k) => [
    `update-remove:${k}`,
    'a removed member keeps the live value, as CloudFormation does (UpdateSecret merge semantics)',
  ])
);
const VALUE_KEPT_ON_REMOVAL =
  'a removed value source keeps the live secret value (changedSecretValue sends a value only for a declared, changed source)';

const REPLICA_KEY_GAP = 'go-to-k/cdkd#5302';

export const CASES_IAM_SECRETS: TypeCase[] = [
  {
    resourceType: 'AWS::IAM::User',
    provider: () => new IAMUserGroupProvider(),
    physicalId: 'u',
    createOnly: createOnlyOf('AWS::IAM::User'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          UserName: 'u',
          Path: '/p/',
          PermissionsBoundary: `arn:aws:iam::${ACCOUNT}:policy/boundary`,
          LoginProfile: { Password: 'pw-1', PasswordResetRequired: true },
          ManagedPolicyArns: [
            `arn:aws:iam::${ACCOUNT}:policy/m1`,
            `arn:aws:iam::${ACCOUNT}:policy/m2`,
          ],
          Groups: ['g1', 'g2'],
          Policies: [
            { PolicyName: 'p1', PolicyDocument: POLICY_DOCUMENT },
            { PolicyName: 'p2', PolicyDocument: POLICY_DOCUMENT },
          ],
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        expectedSilent: INLINE_POLICY_DOCS_SILENT,
        expectedRemovalThrows: TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
      },
    ],
  },
  {
    resourceType: 'AWS::IAM::Group',
    provider: () => new IAMUserGroupProvider(),
    physicalId: 'g',
    createOnly: createOnlyOf('AWS::IAM::Group'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: {
          GroupName: 'g',
          Path: '/p/',
          ManagedPolicyArns: [
            `arn:aws:iam::${ACCOUNT}:policy/m1`,
            `arn:aws:iam::${ACCOUNT}:policy/m2`,
          ],
          Policies: [
            { PolicyName: 'p1', PolicyDocument: POLICY_DOCUMENT },
            { PolicyName: 'p2', PolicyDocument: POLICY_DOCUMENT },
          ],
        },
        expectedSilent: INLINE_POLICY_DOCS_SILENT,
      },
    ],
  },
  {
    resourceType: 'AWS::IAM::UserToGroupAddition',
    provider: () => new IAMUserGroupProvider(),
    physicalId: 'g',
    createOnly: createOnlyOf('AWS::IAM::UserToGroupAddition'),
    exempt: {},
    targets: [],
    bags: [
      {
        name: 'every declared property',
        bag: { GroupName: 'g', Users: ['u1', 'u2'] },
        // A group move (a recorded GroupName that differs) is proved by its own
        // test in `sdk-wire-coverage-iam-secrets.test.ts`: these probes only ever hold a
        // recorded side WITHOUT one.
        expectedSilent: Object.fromEntries(
          ['update-add', 'update-vary'].map((d) => [
            `${d}:GroupName`,
            'a recorded addition always carries GroupName (create refuses without it), and with none recorded update() reads the desired group as unchanged',
          ])
        ),
        expectedRemovalThrows: {
          'create:GroupName': { why: 'refused when absent, before any call', says: /GroupName is required for/ },
          'create:Users': { why: 'refused when absent, before any call', says: /Users is required for/ },
        },
      },
    ],
  },
  {
    resourceType: 'AWS::SecretsManager::Secret',
    provider: () => new SecretsManagerSecretProvider(),
    physicalId: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:s-AbCdEf`,
    createOnly: createOnlyOf('AWS::SecretsManager::Secret'),
    arm: armRestartingRandom,
    exempt: {},
    targets: [
      { path: ['Tags', 0], command: 'UntagResourceCommand', names: 'k1', notNames: 'k2' },
      { path: ['Tags', 1], command: 'UntagResourceCommand', names: 'k2', notNames: 'k1' },
    ],
    bags: [
      {
        name: 'a generated value',
        bag: {
          Name: 's',
          Description: 'd',
          KmsKeyId: 'alias/k',
          Type: 'aws-partner',
          GenerateSecretString: {
            // Upper case and the space are left, so each exclusion and the
            // placement step change the draw.
            ExcludeCharacters: 'ABC',
            ExcludeLowercase: true,
            ExcludeNumbers: true,
            ExcludePunctuation: true,
            ExcludeUppercase: false,
            GenerateStringKey: 'password',
            IncludeSpace: true,
            PasswordLength: 20,
            RequireEachIncludedType: false,
            SecretStringTemplate: '{"username":"u"}',
          },
          ReplicaRegions: [{ Region: 'us-west-2', KmsKeyId: 'alias/r' }, { Region: 'eu-west-1' }],
          Tags: [
            { Key: 'k1', Value: 'v1' },
            { Key: 'k2', Value: 'v2' },
          ],
        },
        // A JSON document: the default `-alt` suffix would not parse, and
        // `ABC-alt` would exclude nothing more from an upper-case pool.
        variants: {
          'GenerateSecretString.SecretStringTemplate': '{"username":"v"}',
          'GenerateSecretString.ExcludeCharacters': 'ABCD',
        },
        expectedSilent: {
          'create:GenerateSecretString.ExcludeUppercase': DECLARED_DEFAULT,
          ...KEPT_ON_REMOVAL,
          'update-remove:GenerateSecretString': VALUE_KEPT_ON_REMOVAL,
          ...Object.fromEntries(
            ['update-add', 'update-remove'].map((d) => [
              `${d}:ReplicaRegions.0.KmsKeyId`,
              `${REPLICA_KEY_GAP}: a changed key on a region already replicated is never sent`,
            ])
          ),
        },
        expectedRemovalThrows: {
          ...TAG_THROWS(['create', 'update-add', 'update-remove'], 2),
          // Not on update-add: its reduced side's `next` equals `prev`, so the
          // block is unchanged and never judged (nothing is regenerated).
          ...Object.fromEntries(
            ['create', 'update-remove'].flatMap((d) =>
              ['GenerateStringKey', 'SecretStringTemplate'].map((m) => [
                `${d}:GenerateSecretString.${m}`,
                {
                  why: 'GenerateStringKey and SecretStringTemplate are refused one without the other, before any call',
                  says: /must be declared together/,
                },
              ])
            )
          ),
        },
      },
      {
        name: 'a literal value',
        bag: { Name: 's', SecretString: 's3cr3t' },
        expectedSilent: { 'update-remove:SecretString': VALUE_KEPT_ON_REMOVAL },
      },
    ],
  },
];
