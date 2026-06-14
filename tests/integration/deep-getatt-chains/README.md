# Deep GetAtt Chains Example (failure-seeking)

This integration test surfaces **computed-attribute resolution bugs in long
`Fn::GetAtt` chains**, where each resource's POST-CREATE attribute (an ARN /
generated name only known after the AWS create call) feeds the NEXT
resource's property. The chain is 5 resources deep and deliberately MIXES the
two provisioning paths, so a wrong / late attribute resolution on EITHER path
(an SDK provider's `attributes` write, or Cloud Control API's stored
attributes + the resolver's `constructAttribute` fallback) is pinpointed by
the failing link.

## Chain topology

Each arrow means "the left resource's post-create attribute feeds the right
resource's property":

```
A  SNS::Topic                  (SDK)     --TopicArn-->            B.AlarmActions[0]
B  CloudWatch::Alarm           (SDK)     --AlarmName (Ref)-->     C.AlarmRule
C  CloudWatch::CompositeAlarm  (CC-API)  --Arn-->                 D.Value + E.env
D  SSM::Parameter              (SDK)     --Name (Ref)-->          E.env
E  Lambda::Function            (SDK)     -- terminal multi-attribute Fn::Sub consumer
```

`E`'s environment is a multi-attribute `Fn::Sub` that pulls `A.TopicArn`,
`C.Arn` (the CC-API post-create attribute), and `D` (Ref name) all at once,
so the terminal link exercises several upstream attributes in one resolution
pass.

## SDK vs Cloud Control API routing

| Link | Resource | Type | Routing | Post-create attribute consumed downstream |
|------|----------|------|---------|-------------------------------------------|
| A | `ChainTopic` | `AWS::SNS::Topic` | **SDK** | `TopicArn` (= physical id) |
| B | `ChainAlarm` | `AWS::CloudWatch::Alarm` | **SDK** | `Arn`, `Ref` (name) |
| C | `ChainComposite` | `AWS::CloudWatch::CompositeAlarm` | **CC-API** (no SDK provider registered) | `Arn` (stored by CC-API; no `constructAttribute` synthesis case) |
| D | `ChainParam` | `AWS::SSM::Parameter` | **SDK** | `Ref` (name) |
| E | `ChainFn` | `AWS::Lambda::Function` | **SDK** | terminal consumer |

The **critical link is C** (`AWS::CloudWatch::CompositeAlarm`): it is not a
registered SDK provider, so cdkd routes it through Cloud Control API and its
`Arn` attribute comes purely from CC-API's stored attributes — there is no
`constructAttribute` synthesis case for it (unlike, say, `AWS::CloudWatch::Alarm`,
whose `Arn` cdkd can synthesize from the physical id). A regression in the
CC-API attribute capture / resolution path shows up as a malformed or empty
`${ChainComposite.Arn}` substitution in `D.Value` and `E`'s environment.

> See the memory rule `feedback_silent_drop_forces_cc_api_routing` for why an
> SDK-registered type can ALSO be CC-API-routed (a silent-dropped property in
> the template), making the `constructAttribute` fallback load-bearing.

## Cheap by design

SNS / CloudWatch / SSM / IAM / Lambda only. No VPC, no NAT, no asset
publishing (the Lambda uses inline `ZipFile` code). Every named resource
carries a `cdkd:integ-fixture` tag so the destroy assertions confirm removal
by an OWN tag — never `aws:cdk:path`.

## What `verify.sh` asserts

After `cdkd deploy`, it reads each upstream resource's REAL attribute back
from AWS and asserts the downstream consumer resolved to exactly that value:

1. **Link A->B** — alarm `B`'s `AlarmActions[0]` on AWS equals topic `A`'s real `TopicArn`.
2. **Link B->C** — composite `C`'s `AlarmRule` on AWS references alarm `B`'s real name.
3. **Link C->D** — SSM param `D`'s `Value` on AWS equals `composite=<C.Arn>;alarm=<B.Arn>` built from the REAL ARNs read back from AWS (the CC-API attribute -> SDK-resource-property hop).
4. **Link {A,C,D}->E** — Lambda `E`'s environment on AWS resolves `UPSTREAM_TOPIC_ARN` / `UPSTREAM_COMPOSITE_ARN` / `UPSTREAM_PARAM_NAME` / `UPSTREAM_JOINED` to the real upstream attributes (terminal multi-attribute `Fn::Sub`).

A mismatch fails with a message naming the broken link. If `cdkd deploy`
itself fails, `verify.sh` prints the failing resource + error for triage.

Then it runs `cdkd destroy --force` and asserts every named resource is gone
(by its own tag / state-resolved name) and the S3 state file is removed.

## Run

```bash
/run-integ deep-getatt-chains
# or:
bash tests/integration/deep-getatt-chains/verify.sh
```

Required env: `STATE_BUCKET` (auto-derived to `cdkd-state-{accountId}` if
unset), `AWS_REGION` (defaults to `us-east-1`).
