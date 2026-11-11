/**
 * What to do about a resource deleted outside cdkd: `cdkd drift`'s deleted
 * outcome and a deploy whose failed update met one (go-to-k/cdkd#6106) print
 * it. NOT "run cdkd deploy": a deploy diffs the template against STATE, never
 * AWS, so an unchanged template leaves the record as it is and recreates
 * nothing. A LEAF.
 */
export const DELETED_RESOURCE_REMEDY =
  `First confirm it is really gone (in the AWS console or with the AWS CLI). A deploy that ` +
  `does not change it will not recreate it: to recreate it, remove it from the CDK app and ` +
  `deploy, then restore it and deploy again; if it is meant to be gone, the first of those ` +
  `deploys is enough. Anything in the app that references it has to come out with it, and ` +
  `that deploy DELETES those resources too.`;
