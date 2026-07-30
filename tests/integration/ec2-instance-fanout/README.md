# ec2-instance-fanout

Empirical answer to issue #1292: ten t3.nano instances sharing ONE
freshly-named IAM instance profile, launched concurrently, so the dense
IAM-propagation retry schedule (#1288) runs ten overlapping loops against
the `RunInstances` token bucket during a cold propagation window.

`verify.sh` asserts the deploy CONVERGES (10/10 instances created on the
SDK path, 10/10 profile associations live), reports the propagation-retry
and throttle log-line counts plus the deploy wall clock for the issue
record, then destroys and gone-probes everything.

The `suffix` context value keeps the role / instance-profile names cold on
every run — a warm name propagates ~5x faster and would mask the retry
storm this fixture exists to exercise.

Run via `/run-integ ec2-instance-fanout` (never by invoking `cdkd deploy`
directly).
