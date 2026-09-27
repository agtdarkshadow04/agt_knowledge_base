import {
  AdminGetUserCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

const cognito = new CognitoIdentityProviderClient({});

export async function getAccountDetails(username: string) {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  if (!userPoolId) throw new Error('COGNITO_USER_POOL_ID is not configured.');

  const response = await cognito.send(new AdminGetUserCommand({
    UserPoolId: userPoolId,
    Username: username,
  }));
  if (!response.UserCreateDate) throw new Error('Cognito did not return the account creation date.');

  return { createdAt: response.UserCreateDate.toISOString() };
}
