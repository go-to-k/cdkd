# lambda-accelerator-config

cdkd `AWS::Lambda::Function` `AcceleratorConfig` integration test (issue #6352).

`AcceleratorConfig` sets the GPU memory (`AcceleratorMemorySize`, in GB) of a
container-image function on a GPU Lambda Managed Instances capacity provider.
The SDK provider now sends it on `CreateFunction` and
`UpdateFunctionConfiguration` and reads it back from `GetFunction`, so the
function stays on the SDK route instead of auto-routing to Cloud Control.

## What it covers

- `AWS::Lambda::Function`
- `AWS::Lambda::CapacityProvider` (x86_64, `g4dn.xlarge` / `g5.xlarge` /
  `g6.xlarge`, one isolated subnet)

The footprint is the smallest that can run a GPU function: one subnet and one
4-vCPU GPU instance. Whether Lambda Managed Instances accepts a single subnet
and these xlarge GPU types is UNVERIFIED until the first integ run; widen to
more AZs or `.2xlarge` types only if that run refuses them.

## Prerequisites

- The EC2 quota "Running On-Demand G and VT instances" (`L-DB2E81BA`) in the
  region must be at least 4 vCPU. `verify.sh` reads it first and stops before
  any deploy when it is lower.
- Docker, to build the one-file Python image in `gpu-image/` (linux/amd64).

## Phases

1. Deploy with `AcceleratorMemorySize` 12. Assert AWS reports it on `$LATEST`
   and `$LATEST.PUBLISHED`, `provisionedBy=sdk`, and `cdkd drift` is clean.
2. `CDKD_TEST_UPDATE=true`: 6, applied in place (same physical id).
3. `CDKD_TEST_REMOVAL=true`: no `AcceleratorConfig`. The deploy is refused
   before any call, and AWS and state still hold 6.
4. Destroy; assert the function, the capacity provider, the VPC and the state
   file are gone, and no instance is left.

## Run

```bash
/run-integ lambda-accelerator-config
```
