#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AgtKnowledgeBaseStack } from './stack.js';

const app = new cdk.App();
const stage = app.node.tryGetContext('stage') ?? process.env.DEPLOY_STAGE ?? 'dev';

new AgtKnowledgeBaseStack(app, `AgtKnowledgeBase-${stage}`, {
  stage,
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
  description: `AGT Knowledge Base (${stage})`,
});
