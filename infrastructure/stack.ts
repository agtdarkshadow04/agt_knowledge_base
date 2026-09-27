import * as cdk from 'aws-cdk-lib';
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodeLambda from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import { Construct } from 'constructs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

interface AgtStackProps extends StackProps {
  stage: string;
}

export class AgtKnowledgeBaseStack extends Stack {
  constructor(scope: Construct, id: string, props: AgtStackProps) {
    super(scope, id, props);
    const production = props.stage === 'prod';

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'application', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
    });

    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      allowAllOutbound: true,
    });
    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(lambdaSecurityGroup, ec2.Port.tcp(5432), 'API and migration Lambdas');

    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.of('16.15', '16') }),
      instanceType: production
        ? ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL)
        : ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      credentials: rds.Credentials.fromGeneratedSecret('agt_admin', {
        secretName: `agt-knowledge-base/${props.stage}/database`,
      }),
      databaseName: 'agt_knowledge_base',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      publiclyAccessible: false,
      storageEncrypted: true,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      multiAz: production,
      deletionProtection: production,
      backupRetention: production ? Duration.days(14) : Duration.days(1),
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.SNAPSHOT,
      autoMinorVersionUpgrade: true,
    });

    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `agt-knowledge-base-${props.stage}`,
      selfSignUpEnabled: false,
      signInAliases: { username: true, email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      passwordPolicy: {
        minLength: 12,
        requireDigits: true,
        requireLowercase: true,
        requireSymbols: true,
        requireUppercase: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: production ? cognito.FeaturePlan.PLUS : cognito.FeaturePlan.ESSENTIALS,
      standardThreatProtectionMode: production
        ? cognito.StandardThreatProtectionMode.FULL_FUNCTION
        : cognito.StandardThreatProtectionMode.NO_ENFORCEMENT,
      deletionProtection: production,
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const userPoolClient = userPool.addClient('WebClient', {
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      accessTokenValidity: Duration.minutes(60),
      idTokenValidity: Duration.minutes(60),
      refreshTokenValidity: Duration.days(30),
      enableTokenRevocation: true,
    });
    new cognito.CfnUserPoolGroup(this, 'AdminGroup', {
      groupName: 'Admin', userPoolId: userPool.userPoolId,
      description: 'Full knowledge base administration', precedence: 0,
    });
    new cognito.CfnUserPoolGroup(this, 'StandardGroup', {
      groupName: 'Standard', userPoolId: userPool.userPoolId,
      description: 'Article authors and editors', precedence: 10,
    });

    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: `/aws/lambda/agt-knowledge-base-${props.stage}-api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const migrationLogGroup = new logs.LogGroup(this, 'MigrationLogGroup', {
      logGroupName: `/aws/lambda/agt-knowledge-base-${props.stage}-migrate`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    const commonFunctionProps: Omit<nodeLambda.NodejsFunctionProps, 'entry' | 'handler' | 'functionName' | 'logGroup'> = {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(20),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        DB_SECRET_ARN: database.secret!.secretArn,
        DB_HOST: database.dbInstanceEndpointAddress,
        DB_PORT: database.dbInstanceEndpointPort,
        DB_NAME: 'agt_knowledge_base',
        NODE_OPTIONS: '--enable-source-maps',
        NODE_EXTRA_CA_CERTS: '/var/runtime/ca-cert.pem',
      },
      bundling: { minify: true, sourceMap: true, externalModules: ['@aws-sdk/*'] },
    };

    const apiFunction = new nodeLambda.NodejsFunction(this, 'ApiFunction', {
      ...commonFunctionProps,
      functionName: `agt-knowledge-base-${props.stage}-api`,
      logGroup: apiLogGroup,
      entry: join(here, '../backend/handler.ts'),
      handler: 'handler',
    });
    const migrationFunction = new nodeLambda.NodejsFunction(this, 'MigrationFunction', {
      ...commonFunctionProps,
      functionName: `agt-knowledge-base-${props.stage}-migrate`,
      logGroup: migrationLogGroup,
      entry: join(here, '../backend/migrate-handler.ts'),
      handler: 'handler',
      timeout: Duration.minutes(5),
    });
    database.secret!.grantRead(apiFunction);
    database.secret!.grantRead(migrationFunction);

    const api = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `agt-knowledge-base-${props.stage}`,
      corsPreflight: {
        allowOrigins: ['*'],
        allowHeaders: ['authorization', 'content-type'],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PUT,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        maxAge: Duration.hours(12),
      },
    });
    const integration = new integrations.HttpLambdaIntegration('ApiIntegration', apiFunction, {
      payloadFormatVersion: apigwv2.PayloadFormatVersion.VERSION_2_0,
    });
    const authorizer = new authorizers.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );

    api.addRoutes({ path: '/articles', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({ path: '/articles/{id}', methods: [apigwv2.HttpMethod.GET], integration });
    api.addRoutes({ path: '/articles', methods: [apigwv2.HttpMethod.POST], integration, authorizer });
    api.addRoutes({ path: '/articles/{id}', methods: [apigwv2.HttpMethod.PUT, apigwv2.HttpMethod.DELETE], integration, authorizer });
    api.addRoutes({ path: '/articles/{id}/protection', methods: [apigwv2.HttpMethod.PATCH], integration, authorizer });

    const defaultStage = api.defaultStage?.node.defaultChild as apigwv2.CfnStage | undefined;
    if (defaultStage) defaultStage.defaultRouteSettings = { throttlingBurstLimit: 100, throttlingRateLimit: 50 };

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'MigrationFunctionName', { value: migrationFunction.functionName });
    new cdk.CfnOutput(this, 'DatabaseSecretArn', { value: database.secret!.secretArn });
  }
}
