import type {
  ProjectVisibilityType,
  PullRequestBuildApproverRole,
  PullRequestBuildCommentApproval,
  PullRequestBuildPolicy,
  ScopeConfiguration,
  WebhookBuildType,
  WebhookFilter,
  WebhookFilterType,
  WebhookScopeType,
} from '@aws-sdk/client-codebuild';
import { coerceCfnBoolean } from '../../config-shape.js';
import { maskDeep, type MaskerFn } from '../../masked-retry-logger.js';

/**
 * A project's visibility when `UpdateProjectVisibility` has never been called:
 * `CreateProject` has no visibility member and a new project reads back
 * `PRIVATE`.
 */
export const DEFAULT_PROJECT_VISIBILITY = 'PRIVATE';

/**
 * CodeBuild's default artifact encryption key, and what CloudFormation resets a
 * removed `EncryptionKey` to (go-to-k/cdkd#1160, CFn A/B): the AWS managed S3
 * key. `UpdateProject` refuses `''`, and omitting the member keeps the old key.
 */
export const DEFAULT_ENCRYPTION_KEY = 'alias/aws/s3';

/**
 * `Visibility` + `ResourceAccessRole` as `UpdateProjectVisibility` sends them
 * (go-to-k/cdkd#2762). Both ride that one call, `CreateProject` /
 * `UpdateProject` carry neither, and `projectVisibility` is REQUIRED there, so
 * an absent `Visibility` is the default `PRIVATE`.
 *
 * `''` is ABSENT for `ResourceAccessRole`: `readCurrentState` emits it as the
 * placeholder for "no role", which a `drift --revert` hands back.
 */
export type VisibilityRead =
  | { kind: 'usable'; visibility: ProjectVisibilityType; resourceAccessRole?: string }
  | { kind: 'unusable'; reason: string };

export function readVisibility(
  properties: Record<string, unknown>,
  mask: MaskerFn
): VisibilityRead {
  const visibility = properties['Visibility'];
  const role = properties['ResourceAccessRole'];
  const refuse = (key: string, value: unknown): VisibilityRead => ({
    kind: 'unusable',
    reason:
      `AWS::CodeBuild::Project ${key} must be a non-empty string, got ` +
      `${JSON.stringify(maskDeep(value, mask))}`,
  });
  if (visibility != null && (typeof visibility !== 'string' || visibility.trim() === '')) {
    return refuse('Visibility', visibility);
  }
  // `''` is the readback's "no role" placeholder; whitespace names no role and
  // would only be refused by AWS after `CreateProject`.
  if (role != null && (typeof role !== 'string' || (role !== '' && role.trim() === ''))) {
    return refuse('ResourceAccessRole', role);
  }
  return {
    kind: 'usable',
    visibility: ((visibility as string | undefined) ??
      DEFAULT_PROJECT_VISIBILITY) as ProjectVisibilityType,
    ...(typeof role === 'string' && role !== '' && { resourceAccessRole: role }),
  };
}

/**
 * The build type CloudFormation sends on every `UpdateWebhook` whose template
 * declares none (go-to-k/cdkd#5627, CloudTrail), so dropping `BuildType` from a
 * `BUILD_BATCH` webhook resets it. `CreateWebhook` carries it only when declared.
 */
export const DEFAULT_WEBHOOK_BUILD_TYPE: WebhookBuildType = 'BUILD';

/** Tries of `CreateWebhook` on a new project, see `createWebhookOnNewProject`. */
export const NEW_PROJECT_WEBHOOK_ATTEMPTS = 4;
export const NEW_PROJECT_WEBHOOK_RETRY_BASE_MS = 2000;

/** The source location a global or organization webhook requires. */
const DEFAULT_WEBHOOK_SOURCE_LOCATION = 'CODEBUILD_DEFAULT_WEBHOOK_SOURCE_LOCATION';

/** The `Scope` the CloudFormation schema documents when a template names none. */
const DEFAULT_WEBHOOK_SCOPE: WebhookScopeType = 'GITHUB_ORGANIZATION';

/**
 * `Triggers` as the webhook calls take it (go-to-k/cdkd#5627). None of it rides
 * `CreateProject` / `UpdateProject`. Measured against CloudFormation on a real
 * GitHub repository (CFn A/B plus CloudTrail):
 *
 * - `unmanaged`: `Triggers` absent, or carrying no `Webhook`. No webhook call,
 *   so a live webhook is KEPT: removing `Triggers` does not delete it.
 * - `disabled`: `Webhook: false`. `DeleteWebhook` when one is live, else nothing.
 * - `enabled`: `Webhook: true`. `UpdateWebhook` when one is live, else
 *   `CreateWebhook`, so a webhook deleted out of band comes back.
 * - `unusable`: what CloudFormation refuses, plus a malformed block.
 */
export type TriggersRead =
  | { kind: 'unmanaged' | 'disabled' }
  | {
      kind: 'enabled';
      filterGroups?: WebhookFilter[][];
      buildType?: WebhookBuildType;
      scopeConfiguration?: ScopeConfiguration;
      pullRequestBuildPolicy?: PullRequestBuildPolicy;
    }
  | { kind: 'unusable'; reason: string };

/**
 * A `Source.Auth` connection is reached with the project's service role. A
 * `CreateProject` seconds after that role and its grant were created answered
 * `OAuthProviderException` with either sentence below before it succeeded
 * (go-to-k/cdkd#5627, measured on `CreateProject` only). Neither reads as IAM
 * propagation as AWS spells it: the first needs its `(Service:` trailer, which
 * keeps cdkd's OWN expired credentials terminal. This exception is CodeBuild
 * acting on the role, never the caller's credentials, so the wrap restates each
 * sentence in the form that retries, keeping its meaning: a role that truly
 * lacks the grant spends the propagation budget and then says so.
 */
export function relayedConnectionRace(error: unknown, detail: string): string {
  if (!(error instanceof Error) || error.name !== 'OAuthProviderException') return '';
  if (detail.includes('security token included in the request is invalid')) {
    return ' (The security token included in the request is invalid. (Service: CodeBuild))';
  }
  if (detail.includes('not authorized to access connection')) {
    return (
      ' (The service role is not authorized to perform access to the connection ' +
      'Source.Auth names)'
    );
  }
  return '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readTriggers(properties: Record<string, unknown>, mask: MaskerFn): TriggersRead {
  const triggers = properties['Triggers'];
  if (triggers == null) return { kind: 'unmanaged' };
  const refuse = (key: string, expected: string, value: unknown): TriggersRead => ({
    kind: 'unusable',
    reason:
      `AWS::CodeBuild::Project ${key} must be ${expected}, got ` +
      `${JSON.stringify(maskDeep(value, mask))}`,
  });
  if (!isRecord(triggers)) return refuse('Triggers', 'an object', triggers);

  const declared = triggers['Webhook'];
  const webhook = declared == null ? undefined : coerceCfnBoolean(declared);
  if (declared != null && webhook === undefined) {
    return refuse('Triggers.Webhook', 'a boolean', declared);
  }
  const groups = triggers['FilterGroups'];
  const buildType = triggers['BuildType'];

  if (webhook !== true) {
    // CloudFormation's own handler refuses both, an empty `FilterGroups` too,
    // before any webhook call. `PullRequestBuildPolicy` beside no enabled webhook
    // is accepted and sent nowhere (measured); so is `ScopeConfiguration`, by the
    // same reading, unmeasured: it needs a GitHub organization or enterprise.
    for (const [key, value, noun] of [
      ['FilterGroups', groups, 'filter groups'],
      ['BuildType', buildType, 'build type'],
    ] as const) {
      if (value != null) {
        return {
          kind: 'unusable',
          reason: `AWS::CodeBuild::Project Triggers.${key}: cannot specify ${noun} when webhook is disabled`,
        };
      }
    }
    return { kind: webhook === false ? 'disabled' : 'unmanaged' };
  }

  if (buildType != null && typeof buildType !== 'string') {
    return refuse('Triggers.BuildType', 'a string', buildType);
  }
  let filterGroups: WebhookFilter[][] | undefined;
  if (groups != null) {
    if (!Array.isArray(groups) || !groups.every(Array.isArray)) {
      return refuse('Triggers.FilterGroups', 'a list of filter lists', groups);
    }
    const rows = groups as unknown[][];
    if (!rows.every((group) => group.every(isRecord))) {
      return refuse('Triggers.FilterGroups', 'a list of filter lists', groups);
    }
    filterGroups = (rows as Record<string, unknown>[][]).map((group) =>
      group.map((filter) => {
        const excluded = filter['ExcludeMatchedPattern'];
        return {
          type: filter['Type'] as WebhookFilterType,
          pattern: filter['Pattern'] as string,
          ...(excluded != null && {
            excludeMatchedPattern: coerceCfnBoolean(excluded) ?? (excluded as boolean),
          }),
        };
      })
    );
  }

  const policy = triggers['PullRequestBuildPolicy'];
  if (policy != null && !isRecord(policy)) {
    return refuse('Triggers.PullRequestBuildPolicy', 'an object', policy);
  }
  const scope = triggers['ScopeConfiguration'];
  if (scope != null && !isRecord(scope)) {
    return refuse('Triggers.ScopeConfiguration', 'an object', scope);
  }
  // CloudFormation's own refusal.
  if (scope != null) {
    const source = properties['Source'];
    if (!isRecord(source) || source['Location'] !== DEFAULT_WEBHOOK_SOURCE_LOCATION) {
      return {
        kind: 'unusable',
        reason:
          'AWS::CodeBuild::Project Triggers.ScopeConfiguration: cannot specify ' +
          `a scope when the project source location is not ${DEFAULT_WEBHOOK_SOURCE_LOCATION}`,
      };
    }
  }

  return {
    kind: 'enabled',
    ...(filterGroups !== undefined && { filterGroups }),
    ...(buildType != null && { buildType: buildType as WebhookBuildType }),
    ...(scope != null && {
      scopeConfiguration: {
        name: scope['Name'] as string,
        scope: (scope['Scope'] as WebhookScopeType | undefined) ?? DEFAULT_WEBHOOK_SCOPE,
        ...(scope['Domain'] != null && { domain: scope['Domain'] as string }),
      },
    }),
    ...(policy != null && {
      pullRequestBuildPolicy: {
        requiresCommentApproval: policy[
          'RequiresCommentApproval'
        ] as PullRequestBuildCommentApproval,
        ...(policy['ApproverRoles'] != null && {
          approverRoles: policy['ApproverRoles'] as PullRequestBuildApproverRole[],
        }),
      },
    }),
  };
}
