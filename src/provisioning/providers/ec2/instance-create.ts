import {
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
  AssociateIamInstanceProfileCommand,
  DescribeIamInstanceProfileAssociationsCommand,
  ModifyInstanceAttributeCommand,
  waitUntilInstanceRunning,
  type _InstanceType,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { coerceCfnBoolean, replayWarn, requireConfigString } from '../../config-shape.js';
import { refuseMalformedDesiredTags } from '../../tag-list.js';
import { acquireIdempotencyToken } from '../idempotency-token.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { pasteableAwsCommand, WITHHELD_AWS_COMMAND } from '../../replacement-protection-advice.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import {
  describedInstanceAttributes,
  instanceSsmAssociationEntries,
  instanceVolumeEntries,
  isRecordedStandIn,
} from './instance-support.js';
import type { EC2Provider } from '../ec2-provider.js';

// ─── AWS::EC2::Instance ──────────────────────────────────────────

export async function createInstance(
  this: EC2Provider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating EC2 Instance ${logicalId}`);
  // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
  const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

  // go-to-k/cdkd#5630: a LaunchTemplate can supply the image and the
  // instance type, so neither is required nor defaulted beside one.
  const fromLaunchTemplate = properties['LaunchTemplate'] != null;
  const imageId = properties['ImageId'] as string | undefined;
  if (!imageId && !fromLaunchTemplate) {
    throw new ProvisioningError(
      `ImageId is required for EC2 Instance ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  // No `coerceNumber`: an instance type is never a bare scalar, so a number
  // here is a template bug rather than YAML's scalar coercion (issue #1513).
  const instanceType =
    fromLaunchTemplate && properties['InstanceType'] === undefined
      ? undefined
      : requireConfigString(
          properties['InstanceType'],
          't3.micro',
          'AWS::EC2::Instance InstanceType',
          replayWarn(this.logger, context)
        );

  // Built before any AWS call: it refuses an `Ebs.Encrypted` it cannot read
  // as a boolean (issue #5445), which must stop the create, not launch an
  // instance whose volume silently drops the declared encryption.
  const blockDeviceMappings = this.buildBlockDeviceMappings(properties, logicalId);
  // go-to-k/cdkd#5630: refused before any AWS call too.
  const launchOnlyOptions = this.buildLaunchOnlyInstanceOptions(
    properties,
    resourceType,
    logicalId
  );

  // go-to-k/cdkd#5630: the association to create once the instance runs
  // (the refusals above passed). A rollback replay's state record can hold a
  // parameter as a stand-in (an unresolved `{{resolve:...}}` reference or the
  // redaction mask), which must never be sent: the replay launches the
  // instance without the association, says so, and records none.
  let ssmAssociations = instanceSsmAssociationEntries(properties['SsmAssociations']);
  let skippedSsmAssociations = false;
  if (ssmAssociations.length > 0 && isRecordedStandIn(properties['SsmAssociations'])) {
    if (context?.replayingState !== true) {
      throw markNonRetryable(
        new ProvisioningError(
          `${resourceType}.SsmAssociations holds a recorded stand-in (an unresolved {{resolve:...}} reference or the redaction mask), not a value cdkd can send. The instance ${logicalId} was not launched; deploy from the template so the value resolves.`,
          resourceType,
          logicalId
        )
      );
    }
    this.logger.warn(
      safeMsg`${logicalId} (${resourceType}): the state being restored records SsmAssociations with a stand-in parameter (an unresolved {{resolve:...}} reference or the redaction mask), so the instance is launched without its SSM association; deploy from the template to create it.`
    );
    ssmAssociations = [];
    skippedSsmAssociations = true;
  }

  // go-to-k/cdkd#4583: set only when the wiring-failure cleanup could not
  // terminate the instance this call launched.
  let leftBehindId: string | undefined;
  // go-to-k/cdkd#5630: an AttachVolume was accepted, so the wiring cleanup
  // waits for the instance to terminate (see there).
  let volumeAttachIssued = false;
  // go-to-k/cdkd#5630: the association this create made, which the wiring
  // cleanup deletes with the instance.
  let createdAssociationId: string | undefined;
  try {
    const securityGroupIds = properties['SecurityGroupIds'] as string[] | undefined;
    const securityGroups = properties['SecurityGroups'] as string[] | undefined;
    // The CFn `AWS::EC2::Instance.IamInstanceProfile` property is the
    // instance-profile NAME (a plain string) — what `instanceProfile.ref`
    // resolves to in CDK. It is NOT the `{Arn,Name}` object the
    // `RunInstances` SDK input takes (that object shape is what
    // `AWS::EC2::LaunchTemplate` uses). The previous code cast the property
    // to `Record<string, unknown>` and read `['Arn']` / `['Name']` off it —
    // both `undefined` for a string — so `RunInstances` got an empty
    // profile spec, the instance launched with NO profile, and the later
    // associate helper returned early (no arn/name). Normalize all three
    // accepted input shapes (name string / ARN string / `{Arn,Name}` object)
    // into one `{arn?,name?}` here, robust to name-vs-ARN.
    const iamInstanceProfile = this.normalizeIamInstanceProfile(properties['IamInstanceProfile']);

    // Issue #1281: RunInstances rejects NetworkInterfaces[].SubnetId/Groups
    // combined with top-level SubnetId / SecurityGroupIds. CDK emits exactly
    // one shape (setting associatePublicIpAddress swaps the L2 construct
    // from top-level fields to a single NetworkInterfaces entry), so cdkd
    // passes through whichever the template carries rather than merging;
    // a hand-authored template carrying BOTH gets AWS's own rejection,
    // which is the correct error to surface.
    const networkInterfaces = this.buildNetworkInterfaces(properties);

    // Issue #2039. Without a ClientToken, a `RunInstances` whose 500 response
    // was lost AFTER the launch succeeded gets replayed by the deploy
    // engine's outer retry and launches a SECOND instance — with no state
    // entry and no cdkd-owned tag, so `cdkd destroy` never reaches it and it
    // bills indefinitely. The token is stable across every attempt of THIS
    // create (see `idempotency-token.ts`), so the replay is answered by EC2
    // with the instance the first attempt already launched.
    //
    // It is released on exactly the two paths where the instance this token
    // names stops existing — a successful create, and the wiring-failure
    // cleanup that terminates it — because EC2 keeps the token for ~24h and
    // would otherwise answer a later re-create with a TERMINATED instance.
    const runInstancesToken = acquireIdempotencyToken({
      scope: 'RunInstances',
      logicalId,
    });

    // go-to-k/cdkd#5630: `PropagateTagsToVolumeOnCreation` gives the volumes
    // RunInstances creates the instance's tags. CloudFormation applies them
    // at launch only: a later Tags change, or removing the flag, leaves the
    // volume tags as they are (measured us-east-1, 2026-11-04), so update()
    // sends nothing for it.
    const propagateToVolumes =
      coerceCfnBoolean(properties['PropagateTagsToVolumeOnCreation']) === true;
    const { response, tagsApplied } = await this.sendTaggedCreate(
      logicalId,
      'instance',
      desiredTags,
      (TagSpecifications) =>
        this.ec2Client.send(
          new RunInstancesCommand({
            ...(TagSpecifications && {
              TagSpecifications: propagateToVolumes
                ? [
                    ...TagSpecifications,
                    ...TagSpecifications.map((spec) => ({
                      ...spec,
                      ResourceType: 'volume' as const,
                    })),
                  ]
                : TagSpecifications,
            }),
            ClientToken: runInstancesToken.value,
            ...(imageId && { ImageId: imageId }),
            ...(instanceType !== undefined && { InstanceType: instanceType as _InstanceType }),
            KeyName: (properties['KeyName'] as string) ?? undefined,
            NetworkInterfaces: networkInterfaces,
            SecurityGroupIds: securityGroupIds ?? undefined,
            SecurityGroups: securityGroups ?? undefined,
            SubnetId: (properties['SubnetId'] as string) ?? undefined,
            UserData: (properties['UserData'] as string) ?? undefined,
            MinCount: 1,
            MaxCount: 1,
            IamInstanceProfile: iamInstanceProfile
              ? { Arn: iamInstanceProfile.arn, Name: iamInstanceProfile.name }
              : undefined,
            BlockDeviceMappings: blockDeviceMappings,
            // Security-focused backfill (#609). These all ride on RunInstances
            // input so they take effect at launch (no post-create modify needed):
            //  - DisableApiTermination: termination protection (security: a
            //    silent-drop made the user think the instance was protected
            //    when it wasn't).
            //  - MetadataOptions: IMDSv2 enforcement (HttpTokens=required)
            //    mitigates SSRF credential theft.
            //  - Monitoring.Enabled: detailed CloudWatch monitoring.
            //  - EbsOptimized: dedicated EBS throughput.
            //  - CreditSpecification.CpuCredits: T-family burstable mode.
            DisableApiTermination: this.coerceBool(properties['DisableApiTermination']),
            EbsOptimized: this.coerceBool(properties['EbsOptimized']),
            Monitoring: this.buildRunInstancesMonitoring(properties),
            MetadataOptions: this.buildMetadataOptions(properties),
            CreditSpecification: this.buildCreditSpecification(properties),
            // Issue #1276. `SubnetId` already pins the AZ, so this is usually
            // redundant -- but the CFn property exists, the CDK L2 construct
            // always emits it, and leaving it unhandled is what routed L2
            // instances onto the Cloud Control path. When both are present and
            // DISAGREE, AWS rejects the RunInstances call; that is the correct
            // outcome to surface rather than to paper over by dropping one.
            Placement: this.buildPlacement(properties),
            ...launchOnlyOptions,
          })
        )
    );

    const instance = response.Instances?.[0];
    if (!instance?.InstanceId) {
      // Theoretical AWS SDK contract violation: RunInstances returned
      // success but with no Instance. Cannot clean up — we have no
      // InstanceId to terminate. This path has never been observed in
      // practice. If it does happen, the orphan must be tracked down via
      // billing console.
      throw new Error('No instance ID returned from RunInstances');
    }

    const instanceId = instance.InstanceId;
    // go-to-k/cdkd#5511: report before the tags and the running wait.
    reportCreatedResource(logicalId, resourceType, instanceId);

    // RunInstancesCommand has succeeded — AWS has now launched the
    // instance and BILLING HAS STARTED. This is the **cost-leak class**
    // of partial-create orphan: a system-generated InstanceId means
    // cdkd's next-deploy diff cannot detect the orphan by name, and
    // the running instance accrues charges until manual cleanup. If a
    // subsequent wiring call (tags / waiter / describe) throws — most
    // commonly the waiter timing out on a slow-boot AMI, or a typo'd
    // huge InstanceType failing capacity — the instance keeps running.
    // Wrap the wiring in an inner try/catch that issues a best-effort
    // `TerminateInstancesCommand` before re-throwing the original
    // error. We do NOT wait for terminate to complete (the deploy is
    // already failing; making the user wait another 30-120s for the
    // error to surface is bad UX, and if the waiter itself was the
    // wiring failure, waiting again would be ironic). The WARN
    // message names the exact InstanceId so the user can verify
    // termination via `aws ec2 describe-instances` if cleanup itself
    // failed.
    try {
      // Apply tags the create did not carry (go-to-k/cdkd#4971). The
      // CreateTags goes to the instance RunInstances just returned, so it
      // retries an eventually-consistent not-found too (go-to-k/cdkd#5630):
      // applyTags only warns on a failure, which would leave the instance
      // untagged while state records the declared tags.
      if (!tagsApplied)
        await this.applyTags(
          instanceId,
          desiredTags,
          logicalId,
          maskerOrIdentity(context?.maskSecrets),
          (call) => this.whileLaunchedInstanceNotVisible(logicalId, instanceId, call)
        );

      // Wait for instance to reach running state unless --no-wait is set.
      // Same gating pattern as the NAT Gateway wait above. Before issue
      // #1277 this wait was unconditional, so `--no-wait` silently did
      // nothing on any stack containing an EC2 instance.
      // go-to-k/cdkd#5630: declared `Volumes` wait under --no-wait too:
      // AttachVolume refuses an instance that is still `pending`. Declared
      // `SsmAssociations` wait too: the association needs the IAM profile
      // check below, which a `pending` instance cannot take.
      const volumes = instanceVolumeEntries(properties['Volumes']);
      const waitsForRunning =
        process.env['CDKD_NO_WAIT'] !== 'true' || volumes.length > 0 || ssmAssociations.length > 0;
      if (waitsForRunning) {
        this.logger.debug(`Waiting for instance ${instanceId} to be running...`);
        await waitUntilInstanceRunning(
          // Poll cadence matters more here than on any other type, because an
          // instance reaches `running` in ~30-60s — the same order as the poll
          // interval itself, so the interval is a large fraction of the total.
          //
          // The SDK waiter picks each delay as
          //   uniform_random(minDelay, min(minDelay * 2^(attempt-1), maxDelay))
          // so a 5/15 config polls at ~5, ~12.5, ~22.5, ~32.5, ~42.5s and an
          // instance that went `running` at 35s is not SEEN until ~42.5s. The
          // mean detection lag is maxDelay/2 once the backoff saturates, i.e.
          // 7.5s of pure dead time on a ~35s operation, and because each delay
          // is randomized the total swings run to run (measured: 34.9 / 43.5 /
          // 56.6s on one 3-instance stack). 2/5 puts the mean lag at ~1.75s
          // and the cadence in line with what the AWS provider for Terraform
          // does (10s initial delay, then ~3s polls).
          //
          // The extra DescribeInstances calls are cheap and the deploy engine
          // caps concurrency, so the call-volume trade is worth the seconds.
          // Sibling waiters were already tightened to a 10s cap by the #1177
          // sweep; this one and the NAT gateway pair kept the looser 15s.
          { client: this.ec2Client, maxWaitTime: 300, minDelay: 2, maxDelay: 5 },
          { InstanceIds: [instanceId] }
        );
      } else {
        this.logger.debug(
          `Instance ${instanceId} launched (skipping running-state wait per --no-wait)`
        );
      }

      // Ensure the freshly-created IAM instance profile actually bound.
      // cdkd's fast SDK path creates the InstanceProfile only ~1s before
      // RunInstances; an instance profile (and its role membership) takes a
      // few seconds to propagate to EC2's view. RunInstances does NOT
      // synchronously validate the profile against IAM — it accepts the
      // request and associates the profile asynchronously, and when the
      // profile isn't visible yet the launch can complete with NO profile
      // attached and NO error raised (the symptom: the running instance has
      // an empty IamInstanceProfile despite the template requesting one).
      // CloudFormation never hits this because its deployment latency lets
      // the profile settle before launch; cdkd does NOT, so verify the
      // association post-launch and explicitly AssociateIamInstanceProfile
      // (retrying through the propagation window) when it is missing.
      //
      // Under --no-wait the instance is still `pending`, and
      // `AssociateIamInstanceProfile` is rejected outright for any instance
      // not in `running` or `stopped` ("The instance 'i-...' is not in the
      // 'running' or 'stopped' states"). That is not a propagation error the
      // retry loop can absorb — it stays true until the instance reaches
      // `running`, which is exactly the wait --no-wait asked to skip. So the
      // check is skipped and the risk is reported instead: the whole point of
      // --no-wait is that the caller accepts an un-settled resource, but a
      // SILENTLY profile-less instance is a much worse surprise than an
      // unassigned IP, so this warns rather than staying quiet (issue #1279).
      if (iamInstanceProfile) {
        // go-to-k/cdkd#5630: an instance whose declared Volumes made it wait
        // for `running` under --no-wait gets the check too.
        if (!waitsForRunning) {
          // Both commands render through `pasteableAwsCommand` (issue
          // #3136): the profile is a template value, so it is sanitized and
          // shell-quoted, and a value that cannot be printed exactly
          // withholds the command rather than naming another profile.
          const aws = pasteableAwsCommand(context?.maskSecrets);
          const profileRef = iamInstanceProfile.arn ?? iamInstanceProfile.name ?? '';
          // cdkd-profile-display: a DIFFERENT SUBJECT that shares the word.
          // `profileRef` is an `AWS::IAM::InstanceProfile` name or ARN out of
          // the user's own CloudFormation template, not the `--profile <name>`
          // CLI argument go-to-k/cdkd#3377 is about. It reaches this line
          // through the same template-rendering path every other resource
          // property does, and is governed by that path's rules rather than
          // by the CLI-argument ones.
          this.logger.warn(
            `Skipped the IAM instance profile association check for ${logicalId} (${instanceId}) ` +
              `because --no-wait leaves the instance in 'pending', where AssociateIamInstanceProfile ` +
              `is rejected. RunInstances associates the profile asynchronously and can complete with ` +
              `NO profile attached when the profile was created moments earlier. Verify with: ` +
              `${aws`aws ec2 describe-iam-instance-profile-associations --filters Name=instance-id,Values=${instanceId}`.render()}` +
              ` — and if it is missing, re-associate with: ` +
              // `profileRef` lands INSIDE shorthand (`Arn=<value>`), where a
              // `,` starts another key the CLI would send (`x,Name=other`
              // names a different profile), so a value holding one is
              // withheld here; the gate admits a mid-word `,` for names
              // elsewhere (go-to-k/cdkd#4199).
              (profileRef.includes(',')
                ? WITHHELD_AWS_COMMAND
                : aws`aws ec2 associate-iam-instance-profile --instance-id ${instanceId} --iam-instance-profile ${iamInstanceProfile.arn ? aws`Arn=${profileRef}` : aws`Name=${profileRef}`}`.render())
          );
        } else {
          await this.ensureIamInstanceProfileAssociated(
            instanceId,
            iamInstanceProfile.arn,
            iamInstanceProfile.name,
            logicalId
          );
        }
      }

      // go-to-k/cdkd#5630: RunInstances has no SourceDestCheck input, so a
      // declared `false` is set on the launched instance, as CloudFormation
      // does. `true` is EC2's default and needs no call.
      if (coerceCfnBoolean(properties['SourceDestCheck']) === false) {
        await this.whileLaunchedInstanceNotVisible(logicalId, instanceId, () =>
          this.ec2Client.send(
            new ModifyInstanceAttributeCommand({
              InstanceId: instanceId,
              SourceDestCheck: { Value: false },
            })
          )
        );
      }

      // go-to-k/cdkd#5630: attach the declared volumes, as CloudFormation
      // does once the instance runs. A volume another instance holds fails
      // the create (CloudFormation fails it the same way, measured), and the
      // wiring cleanup below terminates the new instance.
      for (const volume of volumes) {
        await this.attachInstanceVolume(logicalId, instanceId, resourceType, volume, () => {
          volumeAttachIssued = true;
        });
      }

      // go-to-k/cdkd#5630: associate the declared SSM document, as
      // CloudFormation does once the instance is launched (it does not wait
      // for the association to execute, and neither does cdkd). A failure
      // fails the create, and the wiring cleanup below terminates the instance.
      for (const entry of ssmAssociations) {
        createdAssociationId = await this.createInstanceSsmAssociation(
          logicalId,
          instanceId,
          entry,
          maskerOrIdentity(context?.maskSecrets)
        );
      }

      // Describe instance to get attributes after running. Under
      // --no-wait the instance can still be `pending` here, so the public
      // address may not be assigned yet; `describedInstanceAttributes`
      // records what is KNOWN and omits what is not (issue #3077).
      const describeResponse = await this.whileLaunchedInstanceNotVisible(
        logicalId,
        instanceId,
        () => this.ec2Client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }))
      );
      const runningInstance = describeResponse.Reservations?.[0]?.Instances?.[0];

      // go-to-k/cdkd#5630: the launch went out without TagSpecifications
      // (sendTaggedCreate's untagged re-send), so the volumes did not get
      // the tags either: apply them to the attached volumes now.
      if (propagateToVolumes && !tagsApplied && desiredTags.length > 0) {
        // The declared Volumes are the template's own AWS::EC2::Volume
        // resources, not volumes the launch created: CloudFormation
        // propagates the tags to the latter only.
        const declaredVolumeIds = new Set(volumes.map((v) => v.VolumeId));
        const volumeIds = (runningInstance?.BlockDeviceMappings ?? [])
          .map((m) => m.Ebs?.VolumeId)
          .filter(
            (id): id is string => typeof id === 'string' && id !== '' && !declaredVolumeIds.has(id)
          );
        if (volumeIds.length === 0) {
          this.logger.warn(
            safeMsg`${logicalId}: PropagateTagsToVolumeOnCreation is set, but the launch went out without tags (the tagged RunInstances was refused) and DescribeInstances reported no attached volume for ${instanceId} yet (under --no-wait the instance may still be pending), so its volumes were not tagged. Tag them with ec2:CreateTags once they are attached.`
          );
        }
        for (const volumeId of volumeIds) {
          await this.applyTags(
            volumeId,
            desiredTags,
            logicalId,
            maskerOrIdentity(context?.maskSecrets)
          );
        }
      }

      const attributes = describedInstanceAttributes(instanceId, runningInstance);

      this.logger.debug(`Successfully created EC2 Instance ${logicalId}: ${instanceId}`);

      runInstancesToken.release();
      if (skippedSsmAssociations) {
        // Record what was created: no association.
        const { SsmAssociations: _skipped, ...effectiveProperties } = properties;
        return { physicalId: instanceId, attributes, effectiveProperties };
      }
      return { physicalId: instanceId, attributes };
    } catch (innerError) {
      if (createdAssociationId !== undefined) {
        // Best effort: the instance is terminated below either way, and
        // CloudFormation leaves an association on a terminated instance.
        try {
          await this.deleteSsmAssociationById(createdAssociationId);
        } catch (associationError) {
          const head = `Could not delete the SSM association ${createdAssociationId} of the partially-created EC2 Instance ${logicalId} (${instanceId}): `;
          this.logger.warn(
            safeMsg`${head}${this.warnFailureSentence(head, associationError, maskerOrIdentity(context?.maskSecrets))}`
          );
        }
      }
      try {
        await this.ec2Client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
        // go-to-k/cdkd#5630: a volume attached to the instance stays
        // `in-use` until the instance is gone, and a rollback deleting that
        // AWS::EC2::Volume next would be refused (VolumeInUse) and leave it
        // behind. Termination detaches it, so wait for it here.
        const terminated = volumeAttachIssued
          ? await this.waitForFailedLaunchTerminated(logicalId, instanceId)
          : undefined;
        if (terminated !== undefined && terminated !== 'terminated') {
          this.logger.warn(
            safeMsg`Instance ${instanceId} of ${logicalId} was not seen terminated after its failed create (${terminated}); a volume it held may still be attached for a moment.`
          );
        }
        retractCreatedResource(logicalId, resourceType, instanceId);
        // Released only now, because only now is the instance this token
        // names actually going away: a retry reusing it would be handed back
        // a terminated instance. The ordering is load-bearing in the other
        // direction too — if the terminate FAILS the instance is still
        // running and billing, and KEEPING the token means the retry is
        // handed that same live instance and re-runs its wiring, instead of
        // launching a second one beside an orphan nothing will ever reach.
        runInstancesToken.release();
        this.logger.debug(
          `Terminate requested for partially-created EC2 Instance ${logicalId} (${instanceId}) after wiring failure (${terminated === undefined ? 'not waiting for terminated state' : `termination wait: ${terminated}`})`
        );
      } catch (cleanupError) {
        leftBehindId = instanceId;
        const cleanupHead = `Failed to terminate partially-created EC2 Instance ${logicalId} (${instanceId}): `;
        this.logger.warn(
          `${cleanupHead}${this.warnFailureSentence(cleanupHead, cleanupError, maskerOrIdentity(context?.maskSecrets))} THE INSTANCE IS STILL RUNNING AND BILLING. Manual termination required: ${pasteableAwsCommand(context?.maskSecrets)`aws ec2 terminate-instances --instance-ids ${instanceId}`.render()}`
        );
      }
      // The resource itself was created: an "already exists" from its wiring
      // is an auxiliary object's, not this resource's name collision (#3826).
      throw markAuxiliaryFailure(innerError, logicalId);
    }
  } catch (error) {
    const thrown =
      error instanceof ProvisioningError
        ? error
        : this.wrapCaughtError(
            maskerOrIdentity(context?.maskSecrets),
            error,
            (text) =>
              new ProvisioningError(
                `Failed to create EC2 Instance ${logicalId}: ${text}`,
                resourceType,
                logicalId,
                undefined,
                error instanceof Error ? error : undefined
              )
          );
    if (leftBehindId !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, leftBehindId);
    }
    throw thrown;
  }
}

/**
 * Normalize the CFn `AWS::EC2::Instance.IamInstanceProfile` property into a
 * `{ arn?, name? }` pair the `RunInstances` / `AssociateIamInstanceProfile`
 * SDK inputs accept.
 *
 * The CFn-canonical shape is a plain STRING — the instance-profile NAME
 * (what `instanceProfile.ref` resolves to in CDK). cdkd's intrinsic
 * resolver hands us that resolved string. For robustness we ALSO accept an
 * ARN string (classified by the `arn:` prefix) and the `{Arn,Name}` object
 * shape (defensive for hand-written / SDK-shaped templates). Returns
 * `undefined` when no profile is requested.
 */
export function normalizeIamInstanceProfile(
  this: EC2Provider,
  raw: unknown
): { arn?: string; name?: string } | undefined {
  if (raw == null) return undefined;
  if (typeof raw === 'string') {
    const value = raw.trim();
    if (value === '') return undefined;
    return value.startsWith('arn:') ? { arn: value } : { name: value };
  }
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const arn = typeof obj['Arn'] === 'string' ? (obj['Arn'] as string) : undefined;
    const name = typeof obj['Name'] === 'string' ? (obj['Name'] as string) : undefined;
    if (!arn && !name) return undefined;
    const normalized: { arn?: string; name?: string } = {};
    if (arn) normalized.arn = arn;
    if (name) normalized.name = name;
    return normalized;
  }
  return undefined;
}

/**
 * Guarantee the requested IAM instance profile is actually associated with
 * the just-launched instance, closing the fresh-profile propagation race.
 *
 * cdkd's fast SDK path creates the `AWS::IAM::InstanceProfile` only ~1s
 * before `RunInstances`. The instance profile (and the role membership the
 * `IAMInstanceProfileProvider` attached to it) takes a few seconds to
 * propagate to EC2's view. `RunInstances` does not synchronously validate
 * the supplied `IamInstanceProfile` — when the profile is not yet visible it
 * can launch the instance WITHOUT the profile and return success with no
 * error. The result is a running instance whose `IamInstanceProfile` is
 * empty even though the template requested one (the `propagation-races-2`
 * integ caught exactly this).
 *
 * Strategy (always run when a profile was requested):
 *  - `DescribeIamInstanceProfileAssociations` for the instance. Only a
 *    fully `associated` association counts as bound — an `associating`
 *    state may never complete when the profile wasn't visible at launch, so
 *    we do NOT treat it as done; we fall through and poll.
 *  - When no `associated` association exists, call
 *    `AssociateIamInstanceProfile`, retrying through the IAM propagation
 *    window on the `Invalid IAM Instance Profile ...` / `NoSuchEntity` /
 *    `not authorized` / `InvalidParameterValue` signals AWS raises while the
 *    just-created profile is still propagating.
 *  - After associating, POLL `DescribeIamInstanceProfileAssociations` until
 *    the association reaches `associated` (bounded) so the profile is
 *    genuinely bound by the time `createInstance` returns — the verify.sh
 *    `describe-instances .IamInstanceProfile` check sees it immediately.
 *    This mirrors the settle CloudFormation gets for free via its latency.
 */
export async function ensureIamInstanceProfileAssociated(
  this: EC2Provider,
  instanceId: string,
  arn: string | undefined,
  name: string | undefined,
  logicalId: string
): Promise<void> {
  if (!arn && !name) return;

  // If RunInstances already fully bound the profile, we're done.
  if (await this.isInstanceProfileAssociated(instanceId)) {
    this.logger.debug(
      `IAM instance profile already associated with instance ${instanceId} (${logicalId})`
    );
    return;
  }

  this.logger.debug(
    `IAM instance profile not bound at launch for instance ${instanceId} (${logicalId}); ` +
      `associating ${arn ?? name} explicitly`
  );

  const maxAttempts = 10;
  let associated = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await this.ec2Client.send(
        new AssociateIamInstanceProfileCommand({
          InstanceId: instanceId,
          IamInstanceProfile: { Arn: arn, Name: name },
        })
      );
      this.logger.debug(
        `AssociateIamInstanceProfile issued for instance ${instanceId} (${logicalId}) ` +
          `on attempt ${attempt}`
      );
      associated = true;
      break;
    } catch (error) {
      // `.detail`, never `.summary`: this value feeds the `includes` tests
      // below, so it must stay AWS's own wording. `.detail` is byte-identical
      // to the old expression for an `Error` and the guarded stringification
      // otherwise, while `.summary` reduces an AWS-authored failure to
      // `<name>. Re-run with --verbose...` and would blind them. (An earlier
      // revision of this comment warned against `.display`, which is not a
      // member of `AwsFailureText` at all -- inert guidance pointing away
      // from the real sibling.)
      const msg = describeAwsFailure(error).detail;
      // Already associated (a concurrent RunInstances-side bind landed
      // between our describe and this associate) is success, not failure.
      if (msg.includes('IncorrectState') || msg.includes('already associated')) {
        this.logger.debug(
          `IAM instance profile already associated with instance ${instanceId} (${logicalId})`
        );
        associated = true;
        break;
      }
      if (this.isInstanceProfilePropagationError(msg) && attempt < maxAttempts) {
        this.logger.debug(
          `IAM instance profile not yet propagated for instance ${instanceId} ` +
            `(associate attempt ${attempt}/${maxAttempts}: ${msg}), retrying in ${attempt}s...`
        );
        await this.sleep(attempt * 1000);
        continue;
      }
      throw error;
    }
  }

  if (!associated) return;

  // AssociateIamInstanceProfile returns while the association is still
  // `associating`. Poll until it flips to `associated` so the profile is
  // genuinely bound before createInstance returns.
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (await this.isInstanceProfileAssociated(instanceId)) {
      this.logger.debug(
        `IAM instance profile is now associated with instance ${instanceId} (${logicalId})`
      );
      return;
    }
    if (attempt < maxAttempts) {
      this.logger.debug(
        `Waiting for IAM instance profile association to reach 'associated' for ` +
          `instance ${instanceId} (${logicalId}) (poll ${attempt}/${maxAttempts})...`
      );
      await this.sleep(attempt * 1000);
    }
  }
  this.logger.warn(
    `IAM instance profile association for instance ${instanceId} (${logicalId}) did not ` +
      `reach 'associated' within the propagation window; the instance may still be missing ` +
      `its profile`
  );
}

/**
 * True iff the instance currently has a fully-`associated` IAM instance
 * profile association. An `associating` state is intentionally NOT counted —
 * a launch-time association that never completes can sit in `associating`
 * forever, so the caller must poll for the terminal `associated` state.
 * A describe failure is treated as "not yet associated" so the caller falls
 * through to the associate/poll path (the real fix), not a false positive.
 */
export async function isInstanceProfileAssociated(
  this: EC2Provider,
  instanceId: string
): Promise<boolean> {
  try {
    const assoc = await this.ec2Client.send(
      new DescribeIamInstanceProfileAssociationsCommand({
        Filters: [{ Name: 'instance-id', Values: [instanceId] }],
      })
    );
    return assoc.IamInstanceProfileAssociations?.some((a) => a.State === 'associated') ?? false;
  } catch (err) {
    this.logger.debug(
      `DescribeIamInstanceProfileAssociations failed for ${instanceId}: ` +
        `${describeAwsFailure(err).detail}`
    );
    return false;
  }
}

/**
 * Classify an AssociateIamInstanceProfile error as a fresh-profile
 * propagation signal worth retrying (vs a hard failure to surface).
 */
export function isInstanceProfilePropagationError(this: EC2Provider, msg: string): boolean {
  return (
    msg.includes('Invalid IAM Instance Profile') ||
    msg.includes('NoSuchEntity') ||
    msg.includes('not authorized') ||
    (msg.includes('InvalidParameterValue') && msg.includes('instance profile'))
  );
}

/** The {@link EC2Provider} methods this module defines. */
export const instanceCreateMethods = {
  createInstance,
  normalizeIamInstanceProfile,
  ensureIamInstanceProfileAssociated,
  isInstanceProfileAssociated,
  isInstanceProfilePropagationError,
};
