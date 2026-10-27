import {
  ACCOUNT,
  createOnlyOf,
  paths,
  type Bag,
  type Throw,
  type TypeCase,
} from './sdk-wire-harness.js';
import { CognitoUserPoolProvider } from '../../../src/provisioning/providers/cognito-provider.js';

/**
 * Batch-7 wire cases (#3723) for `CognitoUserPoolProvider`: `AWS::Cognito::UserPool`.
 *
 * Pins go-to-k/cdkd#5374 (issue #5358) in two parts, each probed on its own:
 * - `UserPoolName` reaches `UpdateUserPool` as `PoolName` (a rename): the
 *   `update-add:UserPoolName` and `update-vary:UserPoolName` probes.
 * - a change to `UsernameAttributes` / `AliasAttributes` /
 *   `UsernameConfiguration` (no `UpdateUserPool` member) is REFUSED before any
 *   call instead of being left out of the request: the `update-add` /
 *   `update-remove` removal throws on those paths.
 */

const POOL_ID = 'us-east-1_AbCdEfGhI';
const LAMBDA = (name: string) => `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${name}`;
const KMS_KEY = `arn:aws:kms:us-east-1:${ACCOUNT}:key/1234abcd-12ab-34cd-56ef-1234567890ab`;
const SNS_ROLE = `arn:aws:iam::${ACCOUNT}:role/sms`;

// `update()` builds `UpdateUserPool` (and `SetUserPoolMfaConfig`) from `next`
// alone (cognito-provider.ts:3151-3297, applyMfaConfig at :2475): `prev` is read
// only by the create-time-only refusal (:3065), the Schema reconcile (:3307) and
// the Policies removal warning (:3141), which sends nothing. A member removed from
// `prev` alone sends the same request; its update-add probe observes delivery, and
// its omission from `next` is what UpdateUserPool reads (the per-field omission
// ledger is at cognito-provider.ts:2623-2669).
const FROM_NEXT =
  'UpdateUserPool / SetUserPoolMfaConfig are built from next; prev is read only by the create-time-only refusal and the Schema reconcile';

/** The top-levels `update()` reads from `prev`: their update-remove probes throw. */
const PREV_READ = new Set([
  'Schema',
  'UsernameAttributes',
  'AliasAttributes',
  'UsernameConfiguration',
]);

const CREATE_TIME_ONLY = (property: string): Throw => ({
  why: `${property} has no UpdateUserPool member, so any change is refused before any call (#5358, cognito-provider.ts:3065-3088)`,
  says: new RegExp(`${property} cannot be changed on an existing user pool`),
});

const SCHEMA_IMMUTABLE: Throw = {
  why: 'removing or modifying an existing Schema attribute is refused: AWS can only ADD custom attributes (cognito-provider.ts:3478-3491)',
  says: /the Schema change \(.*\) is immutable on AWS/,
};

const SCHEMA_NAMELESS: Throw = {
  why: 'a Schema entry with no Name is refused on update (cognito-provider.ts:3439-3448)',
  says: /has a Schema attribute with no Name/,
};

// The prev side of an update-vary probe on a nested Schema leaf keeps the
// attribute minus the leaf's parent, so BOTH sides modify an existing attribute
// and are refused (cognito-provider.ts:3478-3491); create-vary reads the value.
const SCHEMA_NESTED_VARY =
  "update-vary's base keeps the attribute without this constraint block, so both sides modify an existing attribute and are refused; create-vary observes the value";

// Both sides of update-vary change a create-time-only property against `base`
// (which lacks it), so both are refused before any call; create-vary observes
// the value, and the refusal is the update behaviour (#5358).
const CREATE_TIME_ONLY_VARY =
  'both update-vary sides change a create-time-only property, refused before any call (cognito-provider.ts:3065-3088); create-vary observes the value';

const SCHEMA = [
  {
    Name: 'tier',
    AttributeDataType: 'String',
    DeveloperOnlyAttribute: false,
    Mutable: true,
    Required: false,
    StringAttributeConstraints: { MinLength: '1', MaxLength: '64' },
  },
  {
    Name: 'score',
    AttributeDataType: 'Number',
    Mutable: false,
    NumberAttributeConstraints: { MinValue: '0', MaxValue: '100' },
  },
];

/** The update-direction throws every Schema path draws. */
function schemaThrows(): Record<string, Throw> {
  const out: Record<string, Throw> = { 'update-remove:Schema': SCHEMA_IMMUTABLE };
  for (const path of paths(SCHEMA)) {
    const label = `Schema.${path.join('.')}`;
    if (path.length === 1) {
      // Removing a whole attribute: adding it back is an AddCustomAttributes.
      out[`update-remove:${label}`] = SCHEMA_IMMUTABLE;
    } else if (path.length === 2 && path[1] === 'Name') {
      out[`update-add:${label}`] = SCHEMA_NAMELESS;
      out[`update-remove:${label}`] = SCHEMA_NAMELESS;
    } else {
      out[`update-add:${label}`] = SCHEMA_IMMUTABLE;
      out[`update-remove:${label}`] = SCHEMA_IMMUTABLE;
    }
  }
  return out;
}

function createTimeOnlyThrows(property: string, labels: string[]): Record<string, Throw> {
  return Object.fromEntries(
    labels.flatMap((label) => [
      [`update-add:${label}`, CREATE_TIME_ONLY(property)],
      [`update-remove:${label}`, CREATE_TIME_ONLY(property)],
    ])
  );
}

/** Every handled property but AliasAttributes, MFA `ON` with SMS + TOTP + email OTP. */
const POOL_FULL: Bag = {
  UserPoolName: 'pool',
  AutoVerifiedAttributes: ['email', 'phone_number'],
  UsernameAttributes: ['email'],
  UsernameConfiguration: { CaseSensitive: false },
  Policies: {
    PasswordPolicy: {
      MinimumLength: 12,
      PasswordHistorySize: 3,
      RequireLowercase: true,
      RequireNumbers: true,
      RequireSymbols: false,
      RequireUppercase: true,
      TemporaryPasswordValidityDays: 5,
    },
    // No EMAIL_OTP / SMS_OTP / WEB_AUTHN: each meets a pre-flight rule beside
    // MfaConfiguration ON (describeUnsupportedMfaCombination).
    SignInPolicy: { AllowedFirstAuthFactors: ['PASSWORD'] },
  },
  Schema: SCHEMA,
  LambdaConfig: {
    CreateAuthChallenge: LAMBDA('create-challenge'),
    CustomEmailSender: { LambdaArn: LAMBDA('email-sender'), LambdaVersion: 'V1_0' },
    CustomMessage: LAMBDA('custom-message'),
    CustomSMSSender: { LambdaArn: LAMBDA('sms-sender'), LambdaVersion: 'V1_0' },
    DefineAuthChallenge: LAMBDA('define-challenge'),
    InboundFederation: { LambdaArn: LAMBDA('federation'), LambdaVersion: 'V1_0' },
    KMSKeyID: KMS_KEY,
    PostAuthentication: LAMBDA('post-auth'),
    PostConfirmation: LAMBDA('post-confirm'),
    PreAuthentication: LAMBDA('pre-auth'),
    PreSignUp: LAMBDA('pre-signup'),
    PreTokenGeneration: LAMBDA('pre-token'),
    PreTokenGenerationConfig: { LambdaArn: LAMBDA('pre-token-v2'), LambdaVersion: 'V2_0' },
    UserMigration: LAMBDA('migration'),
    VerifyAuthChallengeResponse: LAMBDA('verify-challenge'),
  },
  // Not OPTIONAL: an absent MfaConfiguration beside a factor resolves to
  // OPTIONAL, which would equal the declared value and send the same request.
  MfaConfiguration: 'ON',
  EnabledMfas: ['SOFTWARE_TOKEN_MFA', 'SMS_MFA'],
  EmailAuthenticationMessage: 'Your code is {####}',
  EmailAuthenticationSubject: 'Your code',
  WebAuthnRelyingPartyID: 'auth.example.com',
  WebAuthnUserVerification: 'required',
  WebAuthnFactorConfiguration: 'MULTI_FACTOR_WITH_USER_VERIFICATION',
  UserPoolTags: { tagkey1: 'tagvalue1', tagkey2: 'tagvalue2' },
  AdminCreateUserConfig: {
    AllowAdminCreateUserOnly: true,
    InviteMessageTemplate: {
      EmailMessage: 'Hello {username}, {####}',
      EmailSubject: 'Invite',
      SMSMessage: 'Hi {username} {####}',
    },
    UnusedAccountValidityDays: 7,
  },
  AccountRecoverySetting: {
    RecoveryMechanisms: [
      { Name: 'verified_email', Priority: 1 },
      { Name: 'verified_phone_number', Priority: 2 },
    ],
  },
  UserAttributeUpdateSettings: { AttributesRequireVerificationBeforeUpdate: ['email'] },
  DeletionProtection: 'ACTIVE',
  EmailConfiguration: {
    ConfigurationSet: 'cs',
    EmailSendingAccount: 'DEVELOPER',
    From: 'noreply@example.com',
    ReplyToEmailAddress: 'reply@example.com',
    SourceArn: `arn:aws:ses:us-east-1:${ACCOUNT}:identity/example.com`,
  },
  SmsConfiguration: {
    SnsCallerArn: SNS_ROLE,
    ExternalId: 'ext',
    SnsRegion: 'us-east-1',
    EumsSms: {
      CallerArn: SNS_ROLE,
      ConfigurationSetName: 'sms-cs',
      ExternalId: 'eums-ext',
      InEntityId: 'entity',
      InTemplateId: 'template',
      OriginationIdentity: '+15555550100',
      Region: 'us-east-1',
    },
  },
  VerificationMessageTemplate: {
    DefaultEmailOption: 'CONFIRM_WITH_LINK',
    EmailMessage: 'Code {####}',
    EmailMessageByLink: 'Click {##Verify##}',
    EmailSubject: 'Verify',
    EmailSubjectByLink: 'Verify by link',
    SmsMessage: 'SMS code {####}',
  },
  DeviceConfiguration: {
    ChallengeRequiredOnNewDevice: true,
    DeviceOnlyRememberedOnUserPrompt: false,
  },
  UserPoolAddOns: {
    AdvancedSecurityMode: 'AUDIT',
    AdvancedSecurityAdditionalFlows: { CustomAuthMode: 'AUDIT' },
  },
  EmailVerificationMessage: 'Verify {####}',
  EmailVerificationSubject: 'Verify subject',
  SmsAuthenticationMessage: 'Auth {####}',
  SmsVerificationMessage: 'Verify sms {####}',
  UserPoolTier: 'PLUS',
};

export const COGNITO_CASES: TypeCase[] = [
  {
    resourceType: 'AWS::Cognito::UserPool',
    provider: () => new CognitoUserPoolProvider(),
    physicalId: POOL_ID,
    createOnly: createOnlyOf('AWS::Cognito::UserPool'),
    wholeFromNext: { keys: (key) => !PREV_READ.has(key), reason: FROM_NEXT },
    exempt: {},
    targets: [
      // UpdateUserPool re-sends the tag map from next: the removed key must not ride along.
      {
        path: ['UserPoolTags', 'tagkey1'],
        command: 'UpdateUserPoolCommand',
        names: 'tagkey2',
        notNames: 'tagkey1',
      },
      {
        path: ['UserPoolTags', 'tagkey2'],
        command: 'UpdateUserPoolCommand',
        names: 'tagkey1',
        notNames: 'tagkey2',
      },
    ],
    bags: [
      {
        name: 'every handled property but AliasAttributes, MFA ON',
        bag: POOL_FULL,
        expectedSilent: {
          'update-vary:Schema.0.StringAttributeConstraints.MinLength': SCHEMA_NESTED_VARY,
          'update-vary:Schema.0.StringAttributeConstraints.MaxLength': SCHEMA_NESTED_VARY,
          'update-vary:Schema.1.NumberAttributeConstraints.MinValue': SCHEMA_NESTED_VARY,
          'update-vary:Schema.1.NumberAttributeConstraints.MaxValue': SCHEMA_NESTED_VARY,
          'update-vary:UsernameAttributes.0': CREATE_TIME_ONLY_VARY,
          'update-vary:UsernameConfiguration.CaseSensitive': CREATE_TIME_ONLY_VARY,
        },
        expectedRemovalThrows: {
          ...schemaThrows(),
          ...createTimeOnlyThrows('UsernameAttributes', [
            'UsernameAttributes',
            'UsernameAttributes.0',
          ]),
          ...createTimeOnlyThrows('UsernameConfiguration', [
            'UsernameConfiguration',
            'UsernameConfiguration.CaseSensitive',
          ]),
        },
      },
      {
        name: 'alias sign-in (AliasAttributes, exclusive of UsernameAttributes)',
        bag: { UserPoolName: 'pool', AliasAttributes: ['email', 'preferred_username'] },
        expectedSilent: {
          'update-vary:AliasAttributes.0': CREATE_TIME_ONLY_VARY,
          'update-vary:AliasAttributes.1': CREATE_TIME_ONLY_VARY,
        },
        expectedRemovalThrows: createTimeOnlyThrows('AliasAttributes', [
          'AliasAttributes',
          'AliasAttributes.0',
          'AliasAttributes.1',
        ]),
      },
    ],
  },
];
