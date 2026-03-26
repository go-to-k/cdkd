# S3 + CloudFront Example

This example deploys an S3 bucket with a CloudFront distribution using Origin Access Identity (OAI) for secure access.

## Resources

- **S3 Bucket** - Private bucket with all public access blocked
- **CloudFront Origin Access Identity** - OAI for secure S3 access
- **CloudFront Distribution** - CDN with S3 origin, HTTPS redirect
- **S3 Bucket Policy** - Grants OAI read access to bucket objects

## What it demonstrates

- S3 bucket creation with `removalPolicy: DESTROY`
- CloudFront OAI integration with S3
- Bucket policy granting read access to OAI principal
- Resource dependencies (Distribution depends on Bucket and OAI)
- `Fn::GetAtt` for outputs (distribution domain name, bucket ARN)

## Notes

- CloudFront distributions can take 5-15 minutes to create
- CloudFront distributions can also take several minutes to delete
- The bucket is created with `BlockPublicAccess.BLOCK_ALL` for security

## Deploy

```bash
cdkd deploy S3CloudFrontStack
```

## Destroy

```bash
cdkd destroy S3CloudFrontStack
```
