import {
  CreateTagsCommand,
  CreateVpcEndpointCommand,
  DeleteTagsCommand,
  DeleteVpcEndpointsCommand,
  DescribeVpcEndpointsCommand,
  ModifyVpcEndpointCommand,
  type CreateVpcEndpointCommandInput,
  type EC2Client,
  type IpAddressType,
  type ModifyVpcEndpointCommandInput,
  type VpcEndpoint,
} from '@aws-sdk/client-ec2';
import { getLogger } from '../../utils/logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { describeAwsFailure, verbosePointerTail } from '../../utils/aws-failure-text.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { deployReplaceCommand } from '../../utils/pasteable-command.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
  markRedactedCause,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { markCreatedBeforeFailure } from '../auxiliary-failure.js';
import { reportCreatedResource } from '../created-resource-sink.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { isInterruptedWaitError, startInterruptWatch } from '../interrupt-watch.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { markNotGone } from '../not-gone.js';
import { resolvedResourceTimeoutMs } from '../resource-timeout-registry.js';
import { waitForGoneAfterDelete } from '../delete-gone-wait.js';
import { policyContentKey } from '../policy-document-content.js';
import { planTagDiff, refuseMalformedDesiredTags, tagPlanWarning } from '../tag-list.js';
import { acquireIdempotencyToken } from './idempotency-token.js';
import { isNamedError } from './ec2/common.js';
import {
  VPC_ENDPOINT_CREATE_ONLY,
  createOnlyChange,
  VPC_ENDPOINT_NOT_FOUND_NAMES,
  VPC_ENDPOINT_TYPE,
  endpointState,
  endpointWaitVerdict,
  readBoolean,
  readDnsOptions,
  readIdList,
  readOptionalString,
  readPolicyDocument,
  readbackVpcEndpoint,
  vpcEndpointAttributes,
  type IdListRead,
} from './ec2-vpc-endpoint/shape.js';
import type {
  CreateContext,
  ResourceCreateResult,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  ResourceProvider,
  ResourceUpdateResult,
  UpdateContext,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';

/** The three id lists and the `ModifyVpcEndpoint` members that add and remove each. */
const ID_LISTS = [
  ['SubnetIds', 'AddSubnetIds', 'RemoveSubnetIds'],
  ['SecurityGroupIds', 'AddSecurityGroupIds', 'RemoveSecurityGroupIds'],
  ['RouteTableIds', 'AddRouteTableIds', 'RemoveRouteTableIds'],
] as const;

/**
 * SDK Provider for AWS::EC2::VPCEndpoint (go-to-k/cdkd#6939).
 *
 * `CreateVpcEndpoint` / `ModifyVpcEndpoint` / `CreateTags` / `DeleteTags` /
 * `DeleteVpcEndpoints`. The physical id is the endpoint id (`vpce-...`), the
 * schema's primary identifier and what `Ref` returns, as on Cloud Control.
 *
 * Its own file rather than an `EC2Provider` dispatch arm: it shares none of
 * that provider's per-type helpers, and the dispatch would spread one type
 * over five files.
 *
 * An SDK provider rather than Cloud Control for `--no-wait`: an Interface
 * endpoint stays `pending` for 30-50 s after `CreateVpcEndpoint` returns
 * (measured, us-east-1), and the Cloud Control handler returns only once it
 * is `available`. A create waits for `available` as CloudFormation does,
 * unless `CDKD_NO_WAIT` is set. `DnsEntries` and `NetworkInterfaceIds` are
 * already complete in the create's own answer (measured, private DNS on and
 * off), so a `--no-wait` create records them; an update's `ModifyVpcEndpoint`
 * moves the endpoint back to `pending`, so a `--no-wait` update records them
 * only from an `available` read, and an `Fn::GetAtt` of either otherwise
 * reads the endpoint live, waiting while it is `pending`.
 *
 * A delete waits in every mode until the endpoint is gone: its network
 * interfaces hold its subnets and security groups until then (an Interface
 * endpoint about 2 minutes, measured), so the destroy of the VPC around it
 * would fail with `DependencyViolation`.
 */
export class EC2VPCEndpointProvider implements ResourceProvider {
  private readonly ec2Client: EC2Client;
  private logger = getLogger().child('EC2VPCEndpointProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::EC2::VPCEndpoint',
      new Set([
        'VpcId',
        'ServiceName',
        'VpcEndpointType',
        'SubnetIds',
        'SecurityGroupIds',
        'RouteTableIds',
        'PolicyDocument',
        'PrivateDnsEnabled',
        'DnsOptions',
        'IpAddressType',
        'ResourceConfigurationArn',
        'ServiceNetworkArn',
        'ServiceRegion',
        'Tags',
      ]),
    ],
  ]);

  /**
   * Issue #1160: the create-only keys (a removal is a replacement), the id
   * lists (removed ids are removed), `PolicyDocument` (reset to the default
   * full-access policy), `PrivateDnsEnabled` (back to CloudFormation's
   * `false`) and `Tags`. `DnsOptions` and `IpAddressType` have no documented
   * value to reset to, so a removal of either leaves the live value, which
   * the update caller warns about.
   */
  removalHandledInUpdate = new Map<string, ReadonlySet<string>>([
    [
      VPC_ENDPOINT_TYPE,
      new Set([
        ...VPC_ENDPOINT_CREATE_ONLY,
        'SubnetIds',
        'SecurityGroupIds',
        'RouteTableIds',
        'PolicyDocument',
        'PrivateDnsEnabled',
        'Tags',
      ]),
    ],
  ]);

  /** How long and how often the waits poll; tests shorten them. */
  endpointWait = {
    pollIntervalMs: 3_000,
    timeoutMs: 900_000,
    deletePollIntervalMs: 5_000,
    deleteTimeoutMs: 900_000,
    sleep: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
  };

  constructor() {
    this.ec2Client = getAwsClients().ec2;
  }

  /**
   * Wrap a caught failure into the thrown error, keeping the caller's
   * identity out of its message (go-to-k/cdkd#2319): an AWS-authored failure
   * is named by its CLASS, AWS's text goes to debug through the masker.
   */
  private wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(mask(failure.summary));
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /** A non-retryable refusal of a template value, made before any AWS call. */
  private vpcEndpointRefusal(
    logicalId: string,
    what: string,
    physicalId?: string
  ): ProvisioningError {
    return markNonRetryable(
      new ProvisioningError(
        safeMsg`${what} for VPC endpoint ${logicalId}` +
          ` — the endpoint was not ${physicalId === undefined ? 'created' : 'updated'}`,
        VPC_ENDPOINT_TYPE,
        logicalId,
        physicalId
      )
    );
  }

  /** The `CreateVpcEndpoint` members the template declares, every value checked. */
  private createInput(
    logicalId: string,
    properties: Record<string, unknown>
  ): CreateVpcEndpointCommandInput {
    const vpcId = readOptionalString(properties['VpcId']);
    if (vpcId.kind !== 'usable') throw this.vpcEndpointRefusal(logicalId, 'VpcId must be a VPC id');
    const input: CreateVpcEndpointCommandInput = { VpcId: vpcId.value };
    const strings = [
      'ServiceName',
      'VpcEndpointType',
      'IpAddressType',
      'ServiceNetworkArn',
      'ResourceConfigurationArn',
      'ServiceRegion',
    ] as const;
    for (const key of strings) {
      const read = readOptionalString(properties[key]);
      if (read.kind === 'malformed') {
        throw this.vpcEndpointRefusal(logicalId, `${key} must be a non-empty string`);
      }
      if (read.kind === 'usable') (input as unknown as Record<string, unknown>)[key] = read.value;
    }
    for (const [key] of ID_LISTS) {
      const read = readIdList(properties[key]);
      if (read.kind === 'malformed') {
        throw this.vpcEndpointRefusal(logicalId, `${key} must be a list of ids`);
      }
      if (read.kind === 'usable' && read.ids.length > 0) input[key] = read.ids;
    }
    const policy = readPolicyDocument(properties['PolicyDocument']);
    if (policy.kind === 'malformed') {
      throw this.vpcEndpointRefusal(
        logicalId,
        'PolicyDocument must be a policy object or its JSON text'
      );
    }
    if (policy.kind === 'usable') input.PolicyDocument = policy.text;
    const privateDns = readBoolean(properties['PrivateDnsEnabled']);
    if (privateDns.kind === 'malformed') {
      throw this.vpcEndpointRefusal(logicalId, 'PrivateDnsEnabled must be a boolean');
    }
    if (privateDns.kind === 'usable') {
      input.PrivateDnsEnabled = privateDns.value;
    } else if (input.VpcEndpointType === 'Interface') {
      // CloudFormation's documented default is `false`, and Cloud Control
      // creates the endpoint so (measured); EC2's own default for an AWS
      // service is `true`, so the absence is sent explicitly.
      input.PrivateDnsEnabled = false;
    }
    const dns = readDnsOptions(properties['DnsOptions']);
    if (dns.kind === 'malformed')
      throw this.vpcEndpointRefusal(logicalId, `DnsOptions ${dns.reason}`);
    if (dns.kind === 'usable') input.DnsOptions = dns.spec;
    return input;
  }

  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    const mask = maskerOrIdentity(context?.maskSecrets);
    const input = this.createInput(logicalId, properties);
    const tags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);
    if (tags.length > 0) {
      input.TagSpecifications = [{ ResourceType: 'vpc-endpoint', Tags: tags }];
    }
    // The engine's own retry of a create whose answer was lost resends the
    // SAME token and is handed the same endpoint back. Released only on
    // success: a failed wait leaves the endpoint, marked for the rollback.
    const token = acquireIdempotencyToken({ scope: 'CreateVpcEndpoint', logicalId });
    input.ClientToken = token.value;

    this.logger.debug(safeMsg`Creating VPC endpoint ${logicalId}`);
    let endpointId: string | undefined;
    try {
      const response = await this.ec2Client.send(new CreateVpcEndpointCommand(input));
      endpointId = response.VpcEndpoint?.VpcEndpointId;
      if (!endpointId) {
        throw new ProvisioningError(
          safeMsg`CreateVpcEndpoint returned no VpcEndpointId for VPC endpoint ${logicalId}`,
          resourceType,
          logicalId
        );
      }
      reportCreatedResource(logicalId, resourceType, endpointId); // go-to-k/cdkd#5511
      let endpoint = response.VpcEndpoint;
      if (process.env['CDKD_NO_WAIT'] === 'true') {
        this.logger.debug(
          safeMsg`VPC endpoint ${endpointId} created (skipping the available wait per --no-wait)`
        );
      } else {
        endpoint = await this.waitForSettled(endpointId, logicalId, mask);
      }
      token.release();
      return {
        physicalId: endpointId,
        attributes: vpcEndpointAttributes(endpoint, endpointId, true),
      };
    } catch (error) {
      let thrown: unknown = error;
      if (!isInterruptedWaitError(error) && !(error instanceof ProvisioningError)) {
        const cause = error instanceof Error ? error : undefined;
        thrown = this.wrapCaughtError(
          mask,
          error,
          (text) =>
            new ProvisioningError(
              `Failed to create VPC endpoint ${logicalId}: ${text}`,
              resourceType,
              logicalId,
              endpointId,
              cause
            )
        );
      }
      if (endpointId !== undefined) {
        markCreatedBeforeFailure(thrown, logicalId, resourceType, endpointId);
      }
      throw thrown;
    }
  }

  /** The endpoint `DescribeVpcEndpoints` reports, or `undefined` when EC2 holds no such id. */
  private async describe(endpointId: string): Promise<VpcEndpoint | undefined> {
    try {
      const response = await this.ec2Client.send(
        new DescribeVpcEndpointsCommand({ VpcEndpointIds: [endpointId] })
      );
      return response.VpcEndpoints?.find((e) => e.VpcEndpointId === endpointId);
    } catch (error) {
      if (isNamedError(error, VPC_ENDPOINT_NOT_FOUND_NAMES)) return undefined;
      throw error;
    }
  }

  /**
   * Poll until the endpoint is `available` (or `pendingAcceptance`, which only
   * the service owner can end). The first read is one interval in: right after
   * `ModifyVpcEndpoint` an immediate read can still report the `available` the
   * change is about to leave. An id EC2 does not list yet, a throttle or a 5xx
   * keeps polling; a `failed` / `rejected` / `expired` / `partial` / deleting
   * endpoint fails the deploy, as does the deadline.
   */
  private async waitForSettled(
    endpointId: string,
    logicalId: string,
    mask: MaskerFn
  ): Promise<VpcEndpoint> {
    const { pollIntervalMs, timeoutMs, sleep } = this.endpointWait;
    const userTimeoutMs = resolvedResourceTimeoutMs(VPC_ENDPOINT_TYPE);
    const deadline =
      Date.now() +
      (userTimeoutMs === undefined ? timeoutMs : Math.min(timeoutMs, userTimeoutMs / 2));
    const watch = startInterruptWatch(`VPC endpoint ${logicalId} available wait`);
    let last: VpcEndpoint | undefined;
    try {
      for (;;) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        await sleep(pollIntervalMs);
        try {
          last = await this.describe(endpointId);
        } catch (error) {
          if (!isThrottlingError(error) && !isTransientServerError(error)) throw error;
          this.logger.debug(
            mask(
              `VPC endpoint ${endpointId}: not readable yet (${describeAwsFailure(error).summary})`
            )
          );
        }
        const verdict = endpointWaitVerdict(last);
        if (verdict === 'settled' && last !== undefined) return last;
        if (verdict === 'failed') {
          throw markNonRetryable(
            new ProvisioningError(
              safeMsg`VPC endpoint ${logicalId} (${endpointId}) is ${endpointState(last) ?? 'unknown'}, so it will not become available`,
              VPC_ENDPOINT_TYPE,
              logicalId,
              endpointId
            )
          );
        }
        if (Date.now() >= deadline) {
          throw markNonRetryable(
            new ProvisioningError(
              safeMsg`VPC endpoint ${logicalId} (${endpointId}) was still ${endpointState(last) ?? 'unreadable'} when its available wait ran out`,
              VPC_ENDPOINT_TYPE,
              logicalId,
              endpointId
            )
          );
        }
      }
    } finally {
      watch.dispose();
    }
  }

  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    assertRegionMatch(
      context?.expectedRegion ? await this.ec2Client.config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    const mask = maskerOrIdentity(context?.maskSecrets);
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);
    // A create-only change reaches update() only from `cdkd drift --revert`
    // (the diff replaces the endpoint otherwise): refused, never a no-op. An
    // absent VpcEndpointType is CloudFormation's `Gateway`, which the drift
    // readback spells out.
    const changedCreateOnly = createOnlyChange(properties, previousProperties);
    if (changedCreateOnly !== undefined) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `${changedCreateOnly} cannot change in place; re-deploy with ${deployReplaceCommand()}`
      );
    }
    // A state-borne desired bag (a rollback replay, a drift revert) cannot be
    // fixed in the template, so a malformed value there keeps the previous
    // one and is warned about; from a template it is refused.
    const stateBorne = context?.replayingState === true || context?.desiredFromAwsReadback === true;
    const kept: string[] = [];
    const unusable = (key: string, what: string): void => {
      if (!stateBorne) throw this.vpcEndpointRefusal(logicalId, `${key} ${what}`, physicalId);
      this.logger.warn(
        safeMsg`VPC endpoint ${logicalId}: the recorded ${key} ${what}; it was left as it is`
      );
      kept.push(key);
    };

    const modify: ModifyVpcEndpointCommandInput = { VpcEndpointId: physicalId };
    let modifying = false;
    const type = properties['VpcEndpointType'];

    try {
      let live: VpcEndpoint | undefined;
      const liveRead = async (): Promise<VpcEndpoint | undefined> =>
        (live ??= await this.describe(physicalId));
      for (const [key, addKey, removeKey] of ID_LISTS) {
        const desired = readIdList(properties[key]);
        // A malformed desired list read as empty would remove every id: it is
        // refused on every path (go-to-k/cdkd#3948).
        if (desired.kind === 'malformed') {
          throw this.vpcEndpointRefusal(logicalId, `${key} must be a list of ids`, physicalId);
        }
        let recorded: IdListRead = readIdList(previousProperties[key]);
        if (recorded.kind === 'malformed') {
          // An unreadable record only misses removals: the live list stands in.
          const endpoint = await liveRead();
          const liveIds =
            key === 'SecurityGroupIds'
              ? (endpoint?.Groups ?? []).flatMap((g) => (g.GroupId ? [g.GroupId] : []))
              : ((key === 'SubnetIds' ? endpoint?.SubnetIds : endpoint?.RouteTableIds) ?? []);
          recorded = { kind: 'usable', ids: liveIds };
        }
        const want = desired.kind === 'usable' ? desired.ids : [];
        const have = recorded.kind === 'usable' ? recorded.ids : [];
        const add = want.filter((id) => !have.includes(id));
        const remove = have.filter((id) => !want.includes(id));
        if (add.length > 0) modify[addKey] = add;
        if (remove.length > 0) modify[removeKey] = remove;
        if (add.length > 0 || remove.length > 0) modifying = true;
      }

      const policy = readPolicyDocument(properties['PolicyDocument']);
      const previousPolicy = readPolicyDocument(previousProperties['PolicyDocument']);
      if (policy.kind === 'malformed') {
        unusable('PolicyDocument', 'is not a policy object or its JSON text');
      } else if (policy.kind === 'usable') {
        if (
          previousPolicy.kind !== 'usable' ||
          policyContentKey(policy.text) !== policyContentKey(previousPolicy.text)
        ) {
          modify.PolicyDocument = policy.text;
          modifying = true;
        }
      } else if (previousPolicy.kind !== 'absent') {
        // CloudFormation's removal: back to the full-access default policy.
        modify.ResetPolicy = true;
        modifying = true;
      }

      const privateDns = readBoolean(properties['PrivateDnsEnabled']);
      const previousPrivateDns = readBoolean(previousProperties['PrivateDnsEnabled']);
      if (privateDns.kind === 'malformed') {
        unusable('PrivateDnsEnabled', 'is not a boolean');
      } else {
        // Absent is CloudFormation's `false` on an Interface endpoint, what
        // create() sent; another type takes no value.
        const want = privateDns.kind === 'usable' ? privateDns.value : undefined;
        const had = previousPrivateDns.kind === 'usable' ? previousPrivateDns.value : undefined;
        const effective = (flag: boolean | undefined): boolean | undefined =>
          flag ?? (type === 'Interface' ? false : undefined);
        if (effective(want) !== undefined && effective(want) !== effective(had)) {
          modify.PrivateDnsEnabled = effective(want);
          modifying = true;
        }
      }

      const ipAddressType = readOptionalString(properties['IpAddressType']);
      if (ipAddressType.kind === 'malformed') {
        unusable('IpAddressType', 'is not a non-empty string');
      } else if (
        ipAddressType.kind === 'usable' &&
        ipAddressType.value !== previousProperties['IpAddressType']
      ) {
        modify.IpAddressType = ipAddressType.value as IpAddressType;
        modifying = true;
      }

      const dns = readDnsOptions(properties['DnsOptions']);
      if (dns.kind === 'malformed') {
        unusable('DnsOptions', dns.reason);
      } else if (
        dns.kind === 'usable' &&
        JSON.stringify(properties['DnsOptions']) !==
          JSON.stringify(previousProperties['DnsOptions'])
      ) {
        modify.DnsOptions = dns.spec;
        modifying = true;
      }

      if (modifying) {
        await this.ec2Client.send(new ModifyVpcEndpointCommand(modify));
      }

      const plan = planTagDiff(previousProperties['Tags'], properties['Tags']);
      const planWarning = tagPlanWarning(plan, resourceType, physicalId);
      if (planWarning !== undefined) this.logger.warn(planWarning);
      if (plan.remove.length > 0) {
        await this.ec2Client.send(
          new DeleteTagsCommand({
            Resources: [physicalId],
            Tags: plan.remove.map((Key) => ({ Key })),
          })
        );
      }
      if (plan.set.size > 0) {
        await this.ec2Client.send(
          new CreateTagsCommand({
            Resources: [physicalId],
            Tags: [...plan.set].map(([Key, Value]) => ({ Key, Value })),
          })
        );
      }

      // `ModifyVpcEndpoint` returns the endpoint to `pending`: an ordinary
      // deploy waits for `available` again, as CloudFormation does.
      const noWait = process.env['CDKD_NO_WAIT'] === 'true';
      const endpoint =
        modifying && !noWait
          ? await this.waitForSettled(physicalId, logicalId, mask)
          : await this.describe(physicalId);
      // Under --no-wait the one read right after `ModifyVpcEndpoint` can still
      // report the `available` the change is leaving, with the old interfaces:
      // never recorded as settled, so a GetAtt reads the endpoint live.
      const settled = !(modifying && noWait) && endpointWaitVerdict(endpoint) === 'settled';

      let effectiveProperties: Record<string, unknown> | undefined;
      if (kept.length > 0) {
        effectiveProperties = { ...properties };
        for (const key of kept) {
          if (previousProperties[key] === undefined) delete effectiveProperties[key];
          else effectiveProperties[key] = structuredClone(previousProperties[key]);
        }
      }
      return {
        physicalId,
        wasReplaced: false,
        attributes: vpcEndpointAttributes(endpoint, physicalId, settled),
        ...(effectiveProperties !== undefined && { effectiveProperties }),
      };
    } catch (error) {
      if (isInterruptedWaitError(error) || error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update VPC endpoint ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    const mask = maskerOrIdentity(context?.maskSecrets);
    const alreadyGone = async (): Promise<void> => {
      assertRegionMatch(
        await this.ec2Client.config.region(),
        context?.expectedRegion,
        resourceType,
        logicalId,
        physicalId
      );
      this.logger.debug(mask(`VPC endpoint ${physicalId} does not exist, skipping deletion`));
    };
    let response;
    try {
      response = await this.ec2Client.send(
        new DeleteVpcEndpointsCommand({ VpcEndpointIds: [physicalId] })
      );
    } catch (error) {
      if (isNamedError(error, VPC_ENDPOINT_NOT_FOUND_NAMES)) return alreadyGone();
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete VPC endpoint ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
    // A refusal comes back as an `Unsuccessful` item, not an exception. Its
    // message can name the account, so only its code reaches the error.
    const refused =
      response.Unsuccessful?.find((u) => u.ResourceId === physicalId) ?? response.Unsuccessful?.[0];
    if (refused !== undefined) {
      const code = refused.Error?.Code;
      if (code !== undefined && VPC_ENDPOINT_NOT_FOUND_NAMES.has(code)) return alreadyGone();
      if (refused.Error?.Message) {
        this.logger.debug(
          mask(`DeleteVpcEndpoints refused ${physicalId}: ${refused.Error.Message}`)
        );
      }
      const thrown = markNonRetryable(
        new ProvisioningError(
          safeMsg`Failed to delete VPC endpoint ${logicalId}: DeleteVpcEndpoints refused it (${code ?? 'no error code'}).` +
            verbosePointerTail(),
          resourceType,
          logicalId,
          physicalId
        )
      );
      throw code?.includes('NotFound') === true ? markNotGone(thrown) : thrown;
    }

    // Waited in every mode, `--no-wait` included: until the endpoint is gone
    // its network interfaces hold its subnets and security groups, so their
    // deletes, and the VPC's, fail with DependencyViolation. CloudFormation's
    // delete handler also waits (it holds ec2:DescribeVpcEndpoints).
    await waitForGoneAfterDelete({
      what: `VPC endpoint ${physicalId}`,
      resourceType,
      describe: async () => {
        const endpoint = await this.describe(physicalId);
        const state = endpointState(endpoint);
        if (endpoint === undefined || state === 'deleted') return undefined;
        return state ?? 'unknown';
      },
      consequence:
        'AWS finishes the delete on its side; until it does, its network interfaces keep its subnets and security groups from being deleted.',
      failedStatus: (status) =>
        status === 'failed'
          ? markNonRetryable(
              new ProvisioningError(
                safeMsg`VPC endpoint ${logicalId} (${physicalId}) entered the failed state while deleting.` +
                  verbosePointerTail(),
                resourceType,
                logicalId,
                physicalId
              )
            )
          : undefined,
      logger: this.logger,
      pollIntervalMs: this.endpointWait.deletePollIntervalMs,
      maxWaitMs: this.endpointWait.deleteTimeoutMs,
      sleep: this.endpointWait.sleep,
    });
  }

  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string,
    _logicalId: string
  ): Promise<unknown> {
    if (attributeName === 'Id') return physicalId;
    const endpoint = await this.describe(physicalId);
    if (endpoint === undefined) return undefined;
    return vpcEndpointAttributes(endpoint, physicalId, true)[attributeName];
  }

  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    const endpoint = await this.describe(physicalId);
    const state = endpointState(endpoint);
    if (endpoint === undefined || state === 'deleted' || state === 'deleting') {
      return RESOURCE_NOT_FOUND;
    }
    return readbackVpcEndpoint(endpoint, properties);
  }

  /**
   * Adopt an existing endpoint: override-only, like the other EC2 types. An
   * endpoint has no name, so only `--resource <logicalId>=<vpce-id>` names one;
   * the id is verified against `DescribeVpcEndpoints`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (!input.knownPhysicalId) return null;
    const endpoint = await this.describe(input.knownPhysicalId);
    const state = endpointState(endpoint);
    if (endpoint === undefined || state === 'deleted' || state === 'deleting') return null;
    return {
      physicalId: input.knownPhysicalId,
      attributes: vpcEndpointAttributes(
        endpoint,
        input.knownPhysicalId,
        endpointWaitVerdict(endpoint) === 'settled'
      ),
    };
  }
}
