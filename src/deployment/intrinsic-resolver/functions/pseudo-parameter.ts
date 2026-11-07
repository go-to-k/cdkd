import type { IntrinsicFunctionResolver } from '../../intrinsic-function-resolver.js';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../../utils/aws-partition.js';
import {
  AWS_NO_VALUE,
  type ResolverContext,
  effectiveAccountInfoRegion,
  getAccountInfo,
} from '../support.js';

/**
 * Resolve pseudo parameters
 *
 * Pseudo parameters are built-in CloudFormation references like AWS::Region
 */
export async function resolvePseudoParameter(
  resolver: IntrinsicFunctionResolver,
  name: string,
  context?: ResolverContext
): Promise<string | string[] | symbol | undefined> {
  switch (name) {
    // `AWS::Region` and `AWS::Partition` need no account, so they take no STS
    // hop: `getAccountInfo` REFUSES when STS cannot name the account (issue
    // #1730), and a template that never names the account must not fail on
    // that. The values are the ones `getAccountInfo` would have answered —
    // `accountInfoFor` derives both from this same helper.
    case 'AWS::Region':
      return effectiveAccountInfoRegion(resolver.resolverRegion);

    // REFUSES (throws `AccountIdUnavailableError`) when STS cannot name the
    // account and `AWS_ACCOUNT_ID` is unset: there is no placeholder account
    // (issue #1730). Outside any catch in `resolveSub`, so `${AWS::AccountId}`
    // refuses there too rather than staying a literal.
    case 'AWS::AccountId': {
      const accountInfo = await getAccountInfo(resolver.resolverRegion);
      return accountInfo.accountId;
    }

    case 'AWS::Partition':
      return derivePartitionAndUrlSuffix(effectiveAccountInfoRegion(resolver.resolverRegion))
        .partition;

    case 'AWS::StackName':
      return context?.stackName ?? 'UnknownStack';

    case 'AWS::StackId': {
      // cdkd doesn't use CloudFormation stacks, generate a synthetic ID.
      // The partition is derived, not hardcoded (issue #1730 review) — this
      // is the same defect class as `getAccountInfo`'s own field, one site
      // over, and `arn:aws:` is wrong in every non-commercial partition.
      // The REGION segment is folded for the same reason (issue #1850). This
      // site is in `resolvePseudoParameter` rather than `constructAttribute`,
      // so it does NOT inherit that method's destructure-level fold — worth
      // stating, because the fold's own comment calls itself exhaustive and
      // that is true only WITHIN `constructAttribute`.
      const info = await getAccountInfo(resolver.resolverRegion);
      return `arn:${info.partition}:cloudformation:${canonicalizeRegion(info.region)}:${info.accountId}:stack/${context?.stackName ?? 'UnknownStack'}/cdkd`;
    }

    case 'AWS::URLSuffix':
      // Derived rather than hardcoded (issue #1730 review): `amazonaws.com.cn`
      // in `aws-cn`, and CloudFormation resolves `${AWS::URLSuffix}` through
      // exactly this mapping. Deliberately NO `getAccountInfo` hop, unlike
      // `AWS::StackId` which needs the account: the suffix is a pure function
      // of the region. The round trip could only add latency and, on an STS
      // outage, a refusal (issue #1730).
      //
      // An earlier revision justified that by saying `resolverRegion` is what
      // `getAccountInfo(resolver.resolverRegion)` "would have set `region` to
      // anyway". That stopped being true when issue #1882 folded
      // `effectiveAccountInfoRegion`: for a mis-cased `resolverRegion` the
      // two now differ in case. The OUTPUT is unaffected, because
      // `derivePartitionAndUrlSuffix` canonicalizes its own input (issue
      // #1795) -- which is the whole reason the skipped hop is still safe --
      // but the stated reason had to change with it.
      return derivePartitionAndUrlSuffix(resolver.resolverRegion).urlSuffix;

    case 'AWS::NotificationARNs':
      // cdkd has no stack-notification-ARN concept — a cdkd deploy never
      // sets SNS notification ARNs on a stack — so the list is always
      // empty. Returned as an EMPTY LIST, as CloudFormation resolves it (issue #3809): an
      // `Fn::Join` over it renders '' there, and inside `Fn::Sub` it is
      // rejected as a list, which `resolveSub` mirrors. It used to be '',
      // on which `Fn::Join` failed with "resolved to string".
      return [];

    case 'AWS::NoValue':
      // Return special symbol to indicate property should be omitted
      return AWS_NO_VALUE;

    default:
      return undefined;
  }
}
