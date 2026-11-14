import type { StreamDescriptionSummary } from '@aws-sdk/client-kinesis';
import { definedAttributes } from '../../attribute-map.js';

/**
 * The `Fn::GetAtt` attributes a Kinesis stream records, from a
 * `DescribeStreamSummary` of the ACTIVE stream: create, update and
 * `import()` all build it here, so the key sets cannot drift apart —
 * `attributes` REPLACES the record on update.
 *
 * go-to-k/cdkd#6242: `WarmThroughputObject` is recorded as ONE nested object
 * of NUMBERS, which serves the whole attribute and, through the resolver's
 * dotted walk, its members. CloudFormation answers
 * `{"TargetMiBps": 0, "CurrentMiBps": 0}` for a stream without warm throughput
 * — PROVISIONED and ON_DEMAND alike — while `DescribeStreamSummary` reports no
 * `WarmThroughput` at all for those streams (both measured us-east-1,
 * 2026-11-14). The zeros are CloudFormation's reading of that absence on a
 * settled stream, so they are recorded as CloudFormation reports them; every
 * caller reads the stream after it is ACTIVE (create and update wait for it,
 * with or without `--no-wait`). A stream that did not answer at all records
 * no object.
 */
export function streamAttributes(
  summary: StreamDescriptionSummary | undefined
): Record<string, unknown> {
  const warm = summary?.WarmThroughput;
  return definedAttributes({
    Arn: summary?.StreamARN,
    WarmThroughputObject:
      summary === undefined
        ? undefined
        : {
            TargetMiBps: warm?.TargetMiBps ?? 0,
            CurrentMiBps: warm?.CurrentMiBps ?? 0,
          },
  });
}
