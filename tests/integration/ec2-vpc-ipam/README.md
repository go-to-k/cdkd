# EC2 VPC from an IPAM pool

A VPC whose primary CIDR is allocated from an IPAM pool (`Ipv4IpamPoolId` +
`Ipv4NetmaskLength`, no `CidrBlock`), on cdkd's SDK path (issue #5633).

## Resources Created

- **IPAM** - Advanced tier (the free tier refuses a private-scope pool), operating in the stack's region
- **IPAM pool** - IPv4, in the IPAM's private default scope
- **IPAM pool CIDR** - `10.240.0.0/16` provisioned into the pool
- **VPC** - A `/28` allocated from the pool

## Precondition

The region must hold no IPAM: an account has one IPAM per region. `verify.sh`
checks this first and refuses to run otherwise; it never adopts or deletes an
IPAM it did not create.

## Demonstrates

- The VPC stays on the SDK provider, and its CIDR is the pool's allocation
- `Fn::GetAtt Vpc.CidrBlock` resolves to the allocated CIDR after the create
  and after an in-place update (`CDKD_TEST_UPDATE=true` tags the VPC)
- Destroy removes the VPC, the pool, the scope and the IPAM

## Run

```bash
/run-integ ec2-vpc-ipam
```
