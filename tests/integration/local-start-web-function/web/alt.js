// The AWS_LAMBDA_NODEJS_ENTRYPOINT arm: the same server, reporting entry "alt".
process.env.WEB_ENTRY_LABEL = 'alt';
require('./index.js');
