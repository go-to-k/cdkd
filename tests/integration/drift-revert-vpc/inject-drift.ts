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
 *
 * Idempotent: re-running after revert re-injects the same drift cleanly.
 *
 * Reads physical ids either from environment vars (FILESYSTEM_ID /
 * MOUNT_TARGET_ID / NAMESPACE_ID / LOAD_BALANCER_ARN / SG1_ID / SG2_ID)
 * or, when those are unset, from `cdkd state show
 * CdkdDriftRevertVpcExample --json`. The env-var path is what
 * verify.sh uses.
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

const STACK = 'CdkdDriftRevertVpcExample';
const REGION = process.env.AWS_REGION ?? 'us-east-1';

// Drifted values — must differ from what lib/drift-revert-stack.ts
// templates so cdkd drift surfaces them.
const DRIFTED_THROUGHPUT_MODE = 'bursting';
const DRIFTED_NAMESPACE_DESCRIPTION = 'integ-DRIFTED';
const DRIFTED_NAMESPACE_SOA_TTL = 30;

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
}

function resolveResourceIds(): ResolvedIds {
  const envFs = process.env.FILESYSTEM_ID;
  const envMt = process.env.MOUNT_TARGET_ID;
  const envNs = process.env.NAMESPACE_ID;
  const envLb = process.env.LOAD_BALANCER_ARN;
  const envSg1 = process.env.SG1_ID;
  const envSg2 = process.env.SG2_ID;
  if (envFs && envMt && envNs && envLb && envSg1 && envSg2) {
    return {
      fileSystemId: envFs,
      mountTargetId: envMt,
      namespaceId: envNs,
      loadBalancerArn: envLb,
      sg1Id: envSg1,
      sg2Id: envSg2,
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
  if (!fileSystemId || !mountTargetId || !namespaceId || !loadBalancerArn || !sg1Id || !sg2Id) {
    throw new Error(
      `Could not resolve all resource ids from state show JSON: ${JSON.stringify(outputs)}`
    );
  }
  return { fileSystemId, mountTargetId, namespaceId, loadBalancerArn, sg1Id, sg2Id };
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

async function main(): Promise<void> {
  const ids = resolveResourceIds();
  await injectEfsFileSystemDrift(ids.fileSystemId);
  await injectEfsMountTargetDrift(ids.mountTargetId, ids.sg2Id);
  await injectNamespaceDrift(ids.namespaceId);
  await injectAlbDrift(ids.loadBalancerArn, ids.sg2Id);
  console.log('[inject] drift injected — `cdkd drift` should now report exit 1');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
