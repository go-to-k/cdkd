#!/usr/bin/env node
/**
 * Mutates the deployed CdkdDriftRevertVpcExample stack via direct AWS
 * SDK calls so that a subsequent `cdkd drift` reports drift, and `cdkd
 * drift --revert -y` clears it.
 *
 *   - EFS FileSystem: UpdateFileSystem flips ThroughputMode from
 *     'elastic' to 'bursting'.
 *   - EFS MountTarget: ModifyMountTargetSecurityGroups swaps
 *     SecurityGroups from [Sg1Id] to [Sg2Id].
 *   - ServiceDiscovery PrivateDnsNamespace: UpdatePrivateDnsNamespace
 *     mutates Description from 'integ-original' to
 *     'integ-DRIFTED' AND Properties.DnsProperties.SOA.TTL from 60 to
 *     30.
 *   - ELBv2 ALB: SetSecurityGroups swaps SecurityGroups from [Sg1Id] to
 *     [Sg2Id].
 *   - ASG: CreateOrUpdateTags adds a Component=drift-revert-vpc-ADDED tag
 *     (the templated Tags only carry Owner=cdkd-integ; revert calls
 *     DeleteTags on Component); DetachLoadBalancerTargetGroups +
 *     AttachLoadBalancerTargetGroups swap the attached target group
 *     from tg1 to tg2 (revert detaches tg2 + re-attaches tg1).
 *
 * Idempotent: re-running after revert re-injects the same drift cleanly.
 *
 * Reads physical ids either from environment vars (FILESYSTEM_ID /
 * MOUNT_TARGET_ID / NAMESPACE_ID / LOAD_BALANCER_ARN / SG1_ID / SG2_ID /
 * ASG_NAME / ASG_TG1_ARN / ASG_TG2_ARN) or, when those are unset, from
 * `cdkd state show CdkdDriftRevertVpcExample --json`. The env-var path
 * is what verify.sh uses.
 */
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  EFSClient,
  UpdateFileSystemCommand,
  ModifyMountTargetSecurityGroupsCommand,
  DescribeFileSystemsCommand,
} from '@aws-sdk/client-efs';
import {
  ServiceDiscoveryClient,
  UpdatePrivateDnsNamespaceCommand,
} from '@aws-sdk/client-servicediscovery';
import {
  ElasticLoadBalancingV2Client,
  SetSecurityGroupsCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import {
  AutoScalingClient,
  AttachLoadBalancerTargetGroupsCommand,
  CreateOrUpdateTagsCommand,
  DetachLoadBalancerTargetGroupsCommand,
} from '@aws-sdk/client-auto-scaling';

const STACK = 'CdkdDriftRevertVpcExample';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

// Drifted values — must differ from what lib/drift-revert-stack.ts
// templates so cdkd drift surfaces them.
const DRIFTED_THROUGHPUT_MODE = 'bursting';
const DRIFTED_NAMESPACE_DESCRIPTION = 'integ-DRIFTED';
const DRIFTED_NAMESPACE_SOA_TTL = 30;
const DRIFTED_ASG_TAG_KEY = 'Component';
const DRIFTED_ASG_TAG_VALUE = 'drift-revert-vpc-ADDED';

interface StateShowOutput {
  state?: {
    outputs?: Record<string, string>;
  };
}

interface ResolvedIds {
  fileSystemId: string;
  mountTargetId: string;
  namespaceId: string;
  loadBalancerArn: string;
  sg1Id: string;
  sg2Id: string;
  asgName: string;
  asgTg1Arn: string;
  asgTg2Arn: string;
}

function resolveResourceIds(): ResolvedIds {
  const envFs = process.env.FILESYSTEM_ID;
  const envMt = process.env.MOUNT_TARGET_ID;
  const envNs = process.env.NAMESPACE_ID;
  const envLb = process.env.LOAD_BALANCER_ARN;
  const envSg1 = process.env.SG1_ID;
  const envSg2 = process.env.SG2_ID;
  const envAsg = process.env.ASG_NAME;
  const envTg1 = process.env.ASG_TG1_ARN;
  const envTg2 = process.env.ASG_TG2_ARN;
  if (envFs && envMt && envNs && envLb && envSg1 && envSg2 && envAsg && envTg1 && envTg2) {
    return {
      fileSystemId: envFs,
      mountTargetId: envMt,
      namespaceId: envNs,
      loadBalancerArn: envLb,
      sg1Id: envSg1,
      sg2Id: envSg2,
      asgName: envAsg,
      asgTg1Arn: envTg1,
      asgTg2Arn: envTg2,
    };
  }

  const repoRoot = execSync('git rev-parse --show-toplevel').toString().trim();
  const cli = resolve(repoRoot, 'dist', 'cli.js');
  const stateBucket = process.env.STATE_BUCKET;
  const args = ['state', 'show', STACK, '--json'];
  if (stateBucket) args.push('--state-bucket', stateBucket);

  const stdout = execSync(`node ${JSON.stringify(cli)} ${args.join(' ')}`, {
    stdio: ['ignore', 'pipe', 'inherit'],
  }).toString();

  const parsed = JSON.parse(stdout) as StateShowOutput;
  const outputs = parsed.state?.outputs ?? {};
  const fileSystemId = outputs['FileSystemId'];
  const mountTargetId = outputs['MountTargetId'];
  const namespaceId = outputs['NamespaceId'];
  const loadBalancerArn = outputs['LoadBalancerArn'];
  const sg1Id = outputs['Sg1Id'];
  const sg2Id = outputs['Sg2Id'];
  const asgName = outputs['AsgName'];
  const asgTg1Arn = outputs['AsgTg1Arn'];
  const asgTg2Arn = outputs['AsgTg2Arn'];
  if (
    !fileSystemId ||
    !mountTargetId ||
    !namespaceId ||
    !loadBalancerArn ||
    !sg1Id ||
    !sg2Id ||
    !asgName ||
    !asgTg1Arn ||
    !asgTg2Arn
  ) {
    throw new Error(
      `Could not resolve all resource ids from state show JSON: ${JSON.stringify(outputs)}`
    );
  }
  return {
    fileSystemId,
    mountTargetId,
    namespaceId,
    loadBalancerArn,
    sg1Id,
    sg2Id,
    asgName,
    asgTg1Arn,
    asgTg2Arn,
  };
}

async function waitForFileSystemAvailable(efs: EFSClient, fileSystemId: string): Promise<void> {
  // EFS UpdateFileSystem is async — the `LifeCycleState` flips back to
  // 'available' once the throughput-mode change is applied. Poll up to
  // ~5 minutes (matches AWS's typical update window).
  const deadlineMs = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadlineMs) {
    const got = await efs.send(new DescribeFileSystemsCommand({ FileSystemId: fileSystemId }));
    const fs = got.FileSystems?.[0];
    if (fs?.LifeCycleState === 'available') return;
    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`EFS FileSystem ${fileSystemId} did not return to 'available' within 5 min`);
}

async function injectEfsFileSystemDrift(fileSystemId: string): Promise<void> {
  const efs = new EFSClient({ region: REGION });
  // Make sure FS is in 'available' state before issuing UpdateFileSystem
  // (CreateFileSystem flips through 'creating' first).
  await waitForFileSystemAvailable(efs, fileSystemId);
  await efs.send(
    new UpdateFileSystemCommand({
      FileSystemId: fileSystemId,
      ThroughputMode: DRIFTED_THROUGHPUT_MODE,
    })
  );
  console.log(
    `[inject] efs: set ThroughputMode=${DRIFTED_THROUGHPUT_MODE} on FileSystem ${fileSystemId}`
  );
  // Wait for the update to complete so the next test step sees the
  // new value.
  await waitForFileSystemAvailable(efs, fileSystemId);
}

async function injectEfsMountTargetDrift(mountTargetId: string, sg2Id: string): Promise<void> {
  const efs = new EFSClient({ region: REGION });
  await efs.send(
    new ModifyMountTargetSecurityGroupsCommand({
      MountTargetId: mountTargetId,
      SecurityGroups: [sg2Id],
    })
  );
  console.log(
    `[inject] efs: set SecurityGroups=[${sg2Id}] on MountTarget ${mountTargetId}`
  );
}

async function injectNamespaceDrift(namespaceId: string): Promise<void> {
  const sd = new ServiceDiscoveryClient({ region: REGION });
  await sd.send(
    new UpdatePrivateDnsNamespaceCommand({
      Id: namespaceId,
      Namespace: {
        Description: DRIFTED_NAMESPACE_DESCRIPTION,
        Properties: {
          DnsProperties: {
            SOA: { TTL: DRIFTED_NAMESPACE_SOA_TTL },
          },
        },
      },
    })
  );
  console.log(
    `[inject] servicediscovery: set Description=${DRIFTED_NAMESPACE_DESCRIPTION} + SOA.TTL=${DRIFTED_NAMESPACE_SOA_TTL} on namespace ${namespaceId}`
  );
}

async function injectAlbDrift(loadBalancerArn: string, sg2Id: string): Promise<void> {
  const elb = new ElasticLoadBalancingV2Client({ region: REGION });
  await elb.send(
    new SetSecurityGroupsCommand({
      LoadBalancerArn: loadBalancerArn,
      SecurityGroups: [sg2Id],
    })
  );
  console.log(`[inject] elbv2: set SecurityGroups=[${sg2Id}] on LB ${loadBalancerArn}`);
}

async function injectAsgDrift(asgName: string, tg1Arn: string, tg2Arn: string): Promise<void> {
  const asg = new AutoScalingClient({ region: REGION });
  // Add a tag not present in the templated Tags list. Revert exercises
  // applyTagsDiff's delete-side via DeleteTags by Key.
  await asg.send(
    new CreateOrUpdateTagsCommand({
      Tags: [
        {
          ResourceId: asgName,
          ResourceType: 'auto-scaling-group',
          Key: DRIFTED_ASG_TAG_KEY,
          Value: DRIFTED_ASG_TAG_VALUE,
          PropagateAtLaunch: false,
        },
      ],
    })
  );
  console.log(
    `[inject] asg: added tag ${DRIFTED_ASG_TAG_KEY}=${DRIFTED_ASG_TAG_VALUE} on ASG ${asgName}`
  );
  // Swap the attached target group. Detach tg1 then attach tg2. Revert
  // exercises applyTargetGroupArnsDiff's detach + re-attach pair.
  await asg.send(
    new DetachLoadBalancerTargetGroupsCommand({
      AutoScalingGroupName: asgName,
      TargetGroupARNs: [tg1Arn],
    })
  );
  await asg.send(
    new AttachLoadBalancerTargetGroupsCommand({
      AutoScalingGroupName: asgName,
      TargetGroupARNs: [tg2Arn],
    })
  );
  console.log(
    `[inject] asg: detached ${tg1Arn} and attached ${tg2Arn} on ASG ${asgName}`
  );
}

async function main(): Promise<void> {
  const ids = resolveResourceIds();
  await injectEfsFileSystemDrift(ids.fileSystemId);
  await injectEfsMountTargetDrift(ids.mountTargetId, ids.sg2Id);
  await injectNamespaceDrift(ids.namespaceId);
  await injectAlbDrift(ids.loadBalancerArn, ids.sg2Id);
  await injectAsgDrift(ids.asgName, ids.asgTg1Arn, ids.asgTg2Arn);
  console.log('[inject] drift injected — `cdkd drift` should now report exit 1');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
