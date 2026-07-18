# cdkd CodeCommit seed content

This file is committed into the repository's initial commit by the CFn
`Code` property (an S3 zip unpacked into the first commit). The cdkd
`AWS::CodeCommit::Repository` provider reproduces that via `CreateCommit`
(issue #1066). The integ asserts this file is readable via `GetFile` after
deploy.
