# Minimal one-shot container built as a CDK `ContainerImage.fromAsset` asset.
# The verify script asserts the printed marker appears in the container logs,
# which proves cdkd's local run-task resolver classified the (custom-qualifier)
# `cdk-<qualifier>-container-assets-...` image URI as a CDK asset and BUILT it
# from cdk.out — instead of attempting an ECR pull (the pre-#1002-PR-3 behavior
# for any non-`hnb659fds` bootstrap qualifier).
FROM public.ecr.aws/docker/library/busybox:1.36
CMD ["sh", "-c", "echo CDKD_CUSTOM_QUALIFIER_ASSET_OK"]
