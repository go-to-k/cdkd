import type { CloudFormationTemplate } from '../../types/resource.js';
import { derivePartitionAndUrlSuffix, sameRegion } from '../../utils/aws-partition.js';
import { displayAwsMessage, displayIdent, displayStackName } from '../../utils/display-safe.js';
import { parseIamRoleArn } from '../../utils/role-arn.js';
import { markNonRetryable } from '../retryable-errors.js';

/**
 * The CROSS-ACCOUNT `Fn::GetStackOutput` the AWS CDK generates, and how cdkd
 * reads it.
 *
 * For a consumer stack referencing a construct of a producer stack in another
 * account, aws-cdk-lib writes `Fn::GetStackOutput` with a `RoleArn` naming a
 * role it adds to the PRODUCER (`Publish/GetStackOutputRole`). That role
 * trusts only the consumer account's CloudFormation execution role and may
 * only call `cloudformation:DescribeStacks`, so cdkd, which neither runs as
 * that role nor keeps a CloudFormation stack for the producer, cannot use it.
 * cdkd reads the producer's state through the producer account's CDK LOOKUP
 * role instead, which the producer's stack artifact names.
 *
 * Everything here is PURE (no I/O) and runs only for a reference that carries
 * a `RoleArn`; a reference without one never reaches this module.
 */

/** What cdkd needs of a producer stack: its synthesized artifact's fields. */
export interface ProducerArtifact {
  readonly stackName: string;
  readonly account?: string | undefined;
  readonly region?: string | undefined;
  readonly template: CloudFormationTemplate;
  /** `properties.lookupRole.arn` of the stack artifact, as synthesized. */
  readonly lookupRoleArn?: string | undefined;
}

/**
 * Finds the producer artifact of a reference in the cloud assembly a command
 * already holds, by stack name, account and region. Called LAZILY, only for a
 * `Fn::GetStackOutput` that carries a `RoleArn`.
 */
export type ProducerLookup = (
  stackName: string,
  account: string,
  region: string
) => ProducerArtifact | undefined;

/** A {@link ProducerLookup} over the stacks of an assembly (no copy, no scan until called). */
export function producerLookupOver(stacks: readonly ProducerArtifact[]): ProducerLookup {
  return (stackName, account, region) =>
    stacks.find(
      (s) => s.stackName === stackName && s.account === account && sameRegion(s.region, region)
    );
}

/** A role name as IAM allows it, with no path (aws-cdk-lib's generated role has none). */
const ROLE_NAME = '[\\w+=,.@-]{1,64}';
const LITERAL_ROLE_ARN_RE = new RegExp(`^arn:aws[a-z0-9-]*:iam::(\\d{12}):role/(${ROLE_NAME})$`);
const JOIN_TAIL_RE = new RegExp(`^:iam::(\\d{12}):role/(${ROLE_NAME})$`);

/** The S1 shape of a `RoleArn` argument: the account and role name it names. */
export interface RoleArnShape {
  /** `literal`: a string ARN; `join`: aws-cdk-lib's `Fn::Join` over `AWS::Partition`. */
  readonly form: 'literal' | 'join';
  readonly accountId: string;
  readonly roleName: string;
}

function isExactlyKeyed(value: unknown, key: string): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === key;
}

/**
 * S1: the `RoleArn` is a literal role ARN, or EXACTLY the shape aws-cdk-lib
 * writes without `@aws-cdk/core:enablePartitionLiterals`:
 * `{"Fn::Join":["",["arn:",{"Ref":"AWS::Partition"},":iam::<account>:role/<name>"]]}`.
 * Any other value answers `undefined` (a non-literal one keeps its refusal).
 */
export function roleArnShape(raw: unknown): RoleArnShape | undefined {
  if (typeof raw === 'string') {
    const match = LITERAL_ROLE_ARN_RE.exec(raw);
    if (!match || !match[1] || !match[2] || !parseIamRoleArn(raw)) return undefined;
    return { form: 'literal', accountId: match[1], roleName: match[2] };
  }
  if (!isExactlyKeyed(raw, 'Fn::Join')) return undefined;
  const join = raw['Fn::Join'];
  if (!Array.isArray(join) || join.length !== 2 || join[0] !== '') return undefined;
  const parts: unknown = join[1];
  if (!Array.isArray(parts) || parts.length !== 3 || parts[0] !== 'arn:') return undefined;
  const ref: unknown = parts[1];
  if (!isExactlyKeyed(ref, 'Ref') || ref['Ref'] !== 'AWS::Partition') return undefined;
  const tail: unknown = parts[2];
  if (typeof tail !== 'string') return undefined;
  const match = JOIN_TAIL_RE.exec(tail);
  if (!match || !match[1] || !match[2]) return undefined;
  return { form: 'join', accountId: match[1], roleName: match[2] };
}

/** The ARN a {@link RoleArnShape} names, its partition taken from the producer region. */
export function roleArnOf(shape: RoleArnShape, region: string): string {
  const { partition } = derivePartitionAndUrlSuffix(region);
  return `arn:${partition}:iam::${shape.accountId}:role/${shape.roleName}`;
}

/** A CloudFormation execution role principal, as aws-cdk-lib writes the generated role's trust. */
const CFN_EXEC_ROLE_PRINCIPAL_RE =
  /^arn:(?:\$\{AWS::Partition\}|aws[a-z0-9-]*):iam::\d{12}:role\/[^/]*cfn-exec-role[^/]*$/;

/**
 * A trust principal as aws-cdk-lib writes the generated role's: always
 * `{"Fn::Sub": "arn:${AWS::Partition}:iam::<consumer>:role/...cfn-exec-role..."}`
 * (`createGetStackOutputRole` wraps every consumer role in `Fn::Sub`).
 */
function isCfnExecRolePrincipal(principal: unknown): boolean {
  return (
    isExactlyKeyed(principal, 'Fn::Sub') &&
    typeof principal['Fn::Sub'] === 'string' &&
    CFN_EXEC_ROLE_PRINCIPAL_RE.test(principal['Fn::Sub'])
  );
}

/**
 * Whether EVERY principal a trust policy names is a CloudFormation execution
 * role (and the document is the shape aws-cdk-lib writes).
 */
function trustsOnlyCfnExecRoles(document: unknown): boolean {
  if (document === null || typeof document !== 'object' || Array.isArray(document)) return false;
  const statements: unknown = (document as Record<string, unknown>)['Statement'];
  if (!Array.isArray(statements) || statements.length === 0) return false;
  for (const statement of statements) {
    if (statement === null || typeof statement !== 'object' || Array.isArray(statement)) {
      return false;
    }
    const principal: unknown = (statement as Record<string, unknown>)['Principal'];
    if (!isExactlyKeyed(principal, 'AWS')) return false;
    const aws = principal['AWS'];
    const list: unknown[] = Array.isArray(aws) ? aws : [aws];
    if (list.length === 0 || !list.every(isCfnExecRolePrincipal)) return false;
  }
  return true;
}

/**
 * S2: the producer template declares an `AWS::IAM::Role` named `roleName`
 * whose trust principals are ALL CloudFormation execution roles — the role
 * aws-cdk-lib generates for a cross-account reference. It is one role per
 * producer, trusting the consumers' CloudFormation execution roles, so it does
 * not say which consumer a reference belongs to: the refusal names the
 * consumer stack's own account.
 */
export function isGeneratedReaderRole(template: CloudFormationTemplate, roleName: string): boolean {
  const resources = template.Resources;
  if (!resources || typeof resources !== 'object') return false;
  // Own values only: `Object.values` never reaches an inherited member.
  for (const resource of Object.values(resources) as unknown[]) {
    if (resource === null || typeof resource !== 'object') continue;
    const { Type: type, Properties: properties } = resource as {
      Type?: unknown;
      Properties?: unknown;
    };
    if (type !== 'AWS::IAM::Role') continue;
    if (properties === null || typeof properties !== 'object') continue;
    const props = properties as Record<string, unknown>;
    if (props['RoleName'] !== roleName) continue;
    if (trustsOnlyCfnExecRoles(props['AssumeRolePolicyDocument'])) return true;
  }
  return false;
}

/**
 * The producer account's CDK lookup role, usable as a role ARN: the artifact's
 * `${AWS::Partition}` replaced with the producer region's partition. `undefined`
 * when the artifact names none, or names one that is not a role of the
 * producer account.
 */
export function producerLookupRoleArn(
  lookupRoleArn: string | undefined,
  producerRegion: string,
  producerAccount: string
): string | undefined {
  if (typeof lookupRoleArn !== 'string' || lookupRoleArn === '') return undefined;
  const { partition } = derivePartitionAndUrlSuffix(producerRegion);
  const arn = lookupRoleArn.split('${AWS::Partition}').join(partition);
  const parsed = parseIamRoleArn(arn);
  if (!parsed || parsed.accountId !== producerAccount) return undefined;
  return arn;
}

/** The verdict on one `RoleArn`, for the resolver and the deploy pre-flight alike. */
export type CdkCrossAccountRefVerdict =
  /** Not aws-cdk-lib's generated reference: the `RoleArn` is used as written. */
  | { readonly kind: 'not-generated' }
  /** The generated `Fn::Join` shape, with no producer artifact to confirm it against. */
  | { readonly kind: 'producer-absent'; readonly shape: RoleArnShape }
  /** The generated reference; `lookupRoleArn` is `undefined` when the producer names no usable one. */
  | {
      readonly kind: 'generated';
      readonly shape: RoleArnShape;
      readonly lookupRoleArn: string | undefined;
    };

/**
 * Classify a `Fn::GetStackOutput` `RoleArn` (S1 AND S2). `shape` is
 * {@link roleArnShape} of the raw argument; `lookup` is the command's
 * {@link ProducerLookup}. A command that wires none (only `deploy` and `diff`
 * hold the assembly for it) classifies nothing, so its references behave
 * exactly as before.
 */
export function classifyCdkCrossAccountRef(
  shape: RoleArnShape,
  producerStackName: string,
  producerRegion: string,
  lookup: ProducerLookup | undefined
): CdkCrossAccountRefVerdict {
  if (lookup === undefined) return { kind: 'not-generated' };
  const producer = lookup(producerStackName, shape.accountId, producerRegion);
  if (!producer) {
    return shape.form === 'join' ? { kind: 'producer-absent', shape } : { kind: 'not-generated' };
  }
  if (!isGeneratedReaderRole(producer.template, shape.roleName)) return { kind: 'not-generated' };
  return {
    kind: 'generated',
    shape,
    lookupRoleArn: producerLookupRoleArn(producer.lookupRoleArn, producerRegion, shape.accountId),
  };
}

/** The already-RENDERED parts of a {@link cdkCrossAccountRefRefusal} message. */
export interface CdkCrossAccountRefRefusalParts {
  /** The consumer stack, rendered, or `undefined` when unknown. */
  readonly consumer: string | undefined;
  readonly output: string;
  readonly producer: string;
  readonly region: string;
  readonly producerAccount: string;
  readonly roleName: string;
  /** The consumer stack's own account, or `undefined` when unknown. */
  readonly consumerAccount: string | undefined;
  /** Why cdkd could not read through the lookup role, as a rendered clause. */
  readonly reason: string;
  /**
   * The producer artifact names NO lookup role (a synthesizer such as
   * `CliCredentialsStackSynthesizer`), so bootstrapping alone cannot help:
   * remedy (1) then says to synthesize the producer with one that does.
   */
  readonly noLookupRole?: boolean;
}

/** A value inside a pasteable call: single-quoted when bare, as-is when already JSON-quoted. */
function quotedArg(rendered: string): string {
  return rendered.startsWith('"') ? rendered : `'${rendered}'`;
}

/**
 * The refusal of an aws-cdk-lib-generated cross-account reference cdkd cannot
 * read. Every part is RENDERED by the caller through the display helpers.
 */
export function cdkCrossAccountRefRefusal(parts: CdkCrossAccountRefRefusalParts): string {
  // The account comes from the manifest's `environment`, which admits any
  // character but `/`: only a 12-digit account id is printed, so nothing a
  // terminal interprets reaches it through this pasteable command.
  const consumerAccount =
    parts.consumerAccount !== undefined && /^\d{12}$/.test(parts.consumerAccount)
      ? parts.consumerAccount
      : '<consumer-account>';
  // ONE period between the reason and the next sentence, whatever the reason
  // (an AWS message often ends in its own) brings.
  const reason = parts.reason.replace(/[\s.]+$/, '');
  const trust =
    `'cdk bootstrap --trust-for-lookup ${consumerAccount}' ` + `(or '--trust ${consumerAccount}')`;
  const remedyOne = parts.noLookupRole
    ? `(1) synthesize stack ${parts.producer} with a stack synthesizer that names a lookup ` +
      `role (the default DefaultStackSynthesizer), and in account ${parts.producerAccount} run ` +
      `${trust} so the identity running cdkd can assume it; or `
    : `(1) in account ${parts.producerAccount}, run ${trust} so the identity running cdkd ` +
      `can assume the lookup role; or `;
  return (
    `Fn::GetStackOutput: cannot read output ${parts.output} of stack ${parts.producer} ` +
    `(region ${parts.region}, account ${parts.producerAccount})` +
    `${parts.consumer ? ` for stack ${parts.consumer}` : ''}. ` +
    `Its RoleArn names ${parts.roleName}, a role the AWS CDK generates for a cross-account ` +
    `reference that trusts only the consumer account's CloudFormation execution role, which ` +
    `cdkd does not use; cdkd reads the producer's cdkd state through the producer ` +
    `account's CDK lookup role instead, but ${reason}. ` +
    `Fix it one of two ways: ` +
    remedyOne +
    `(2) write the reference as cdk.Fn.getStackOutput(${quotedArg(parts.producer)}, ` +
    `${quotedArg(parts.output)}, ${quotedArg(parts.region)}, '<roleArn>') with a role in ` +
    `account ${parts.producerAccount} that trusts the identity running cdkd and allows ` +
    `s3:GetBucketLocation and s3:GetObject on cdkd-state-${parts.producerAccount}. ` +
    `See https://cdkd.dev/cross-stack-references/#reading-from-another-account`
  );
}

/** The {@link CdkCrossAccountRefRefusalParts.reason} of a `producer-absent` verdict. */
export function producerAbsentReason(producerAccount: string): string {
  return (
    `this producer stack (account ${producerAccount}) is not in this app's cloud assembly, ` +
    `so cdkd can neither confirm the role is the generated one nor find the lookup role`
  );
}

/** The {@link CdkCrossAccountRefRefusalParts.reason} of a producer naming no usable lookup role. */
export function noLookupRoleReason(producerAccount: string): string {
  return (
    `the producer stack's artifact names no CDK lookup role in account ${producerAccount} ` +
    `(its stack synthesizer does not use the bootstrap lookup role)`
  );
}

/**
 * Whether a failed read through the lookup role is the lookup role being
 * DENIED (not trusted, no S3 permission, the role absent): an AccessDenied-class
 * name or a 403 anywhere along a bounded `cause` chain. AssumeRole and the state
 * read both wrap the SDK error as their `cause`. Anything else (a malformed
 * record, a missing bucket, throttling, a network or 5xx failure) is not.
 */
export function isLookupRoleDenial(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current !== null && typeof current === 'object'; depth++) {
    const name = (current as { name?: unknown }).name;
    if (
      name === 'AccessDenied' ||
      name === 'AccessDeniedException' ||
      name === 'NoSuchEntity' ||
      name === 'NoSuchEntityException'
    ) {
      return true;
    }
    const status = (current as { $metadata?: { httpStatusCode?: unknown } }).$metadata
      ?.httpStatusCode;
    if (status === 403) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The INNERMOST error of a failed read through the lookup role, rendered as
 * `<name>: <message>`. The AssumeRole and state-read paths wrap the AWS error
 * in text written for a user-chosen role (a trust-policy hint); for the
 * generated reference that advice is wrong, so only AWS's own words are shown.
 */
export function describeInnermostAwsError(error: unknown): string {
  let innermost: unknown = error;
  for (let depth = 0; depth < 6; depth++) {
    const cause: unknown =
      innermost !== null && typeof innermost === 'object'
        ? (innermost as { cause?: unknown }).cause
        : undefined;
    if (cause === null || typeof cause !== 'object') break;
    innermost = cause;
  }
  if (!(innermost instanceof Error)) return displayAwsMessage(String(innermost));
  const code = (innermost as { Code?: unknown }).Code;
  const name = typeof code === 'string' && code !== '' ? code : innermost.name;
  const message = displayAwsMessage(innermost.message);
  return name && name !== 'Error' ? `${displayIdent(name)}: ${message}` : message;
}

/** One `Fn::GetStackOutput` argument carrying a `RoleArn`, as a template holds it. */
export interface RoleArnReference {
  readonly consumer: string;
  readonly args: Record<string, unknown>;
}

/**
 * The `deploy` PRE-FLIGHT: refuse, before anything is provisioned, an
 * aws-cdk-lib-generated cross-account reference of a stack being deployed
 * that cdkd can already tell it cannot read (no producer artifact, or a
 * producer naming no lookup role). Pure: the references come from the
 * cross-stack walk `deploy` already runs, and a denied AssumeRole is left to
 * the resolver, which needs credentials this point does not have.
 *
 * Only LITERAL `StackName` / `OutputName` / `Region` are checked; any other
 * reference is left to the resolver. Stacks are keyed by NAME (`deployed`,
 * `consumerOf`), as everywhere in the deploy command's stack selection.
 */
export function refuseUnreadableCdkCrossAccountRefs(
  refs: readonly RoleArnReference[],
  deployed: ReadonlySet<string>,
  consumerOf: (stackName: string) => { region?: string | undefined; account?: string | undefined },
  lookup: ProducerLookup
): void {
  for (const { consumer, args } of refs) {
    if (!deployed.has(consumer)) continue;
    const shape = roleArnShape(args['RoleArn']);
    if (shape === undefined) continue;
    const stackName = args['StackName'];
    const outputName = args['OutputName'];
    const consumerStack = consumerOf(consumer);
    const region = args['Region'] ?? consumerStack.region;
    if (typeof stackName !== 'string' || typeof outputName !== 'string') continue;
    if (typeof region !== 'string' || region === '') continue;
    const verdict = classifyCdkCrossAccountRef(shape, stackName, region, lookup);
    let reason: string | undefined;
    if (verdict.kind === 'producer-absent') reason = producerAbsentReason(shape.accountId);
    else if (verdict.kind === 'generated' && verdict.lookupRoleArn === undefined) {
      reason = noLookupRoleReason(shape.accountId);
    }
    if (reason === undefined) continue;
    throw markNonRetryable(
      new Error(
        cdkCrossAccountRefRefusal({
          consumer: displayStackName(consumer),
          output: displayIdent(outputName),
          producer: displayStackName(stackName),
          region: displayIdent(region),
          producerAccount: shape.accountId,
          roleName: displayIdent(shape.roleName),
          consumerAccount: consumerStack.account,
          reason,
          noLookupRole: verdict.kind === 'generated',
        })
      )
    );
  }
}
