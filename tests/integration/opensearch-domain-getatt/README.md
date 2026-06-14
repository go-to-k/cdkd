# opensearch-domain-getatt

Failure-seeking integ for the CC-API attribute-enrichment gap on
`AWS::OpenSearchService::Domain`.

`AWS::OpenSearchService::Domain` has no SDK provider, so it always routes
through Cloud Control. Pre-fix, `Fn::GetAtt(<Domain>, 'DomainEndpoint')` /
`'Arn'` fell through the intrinsic resolver's `constructAttribute` to the
physicalId (the domain NAME) instead of the real `*.es.amazonaws.com` endpoint
hostname / `arn:aws:es:...:domain/...` ARN.

The smallest public single-node `t3.small.search` domain (10 GiB gp3, no VPC),
plus two SSM Parameters whose `Value` is `Fn::GetAtt` against the domain's
`DomainEndpoint` / `Arn`. `verify.sh` asserts the stored values are the real
endpoint / ARN, deploys + destroys, and checks 0 orphans.

NOTE: OpenSearch domain create + delete are SLOW (~15-20 min each).

## Run

    AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<acct> bash verify.sh
