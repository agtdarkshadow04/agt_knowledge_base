import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
  UserNotFoundException,
} from '@aws-sdk/client-cognito-identity-provider';

function arg(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const userPoolId = arg('user-pool-id') ?? process.env.COGNITO_USER_POOL_ID;
const username = arg('username');
const email = arg('email');
const confirmed = process.argv.includes('--confirm');

if (!confirmed || !userPoolId || !username || !email) {
  console.error('Usage: npm run admin:bootstrap -- --user-pool-id <id> --username <name> --email <address> --confirm');
  console.error('AWS credentials with explicit Cognito administration permissions are required.');
  process.exit(2);
}

const client = new CognitoIdentityProviderClient({});
try {
  await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
} catch (error) {
  if (!(error instanceof UserNotFoundException)) throw error;
  await client.send(new AdminCreateUserCommand({
    UserPoolId: userPoolId,
    Username: username,
    DesiredDeliveryMediums: ['EMAIL'],
    UserAttributes: [{ Name: 'email', Value: email }, { Name: 'name', Value: username }],
  }));
}

await client.send(new AdminAddUserToGroupCommand({
  UserPoolId: userPoolId,
  Username: username,
  GroupName: 'Admin',
}));
console.log(`Granted Admin to ${username}. Cognito remains the credential store; no password was handled by this script.`);
