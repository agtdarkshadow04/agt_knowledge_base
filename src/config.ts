import { Amplify } from 'aws-amplify';

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID as string | undefined;
const userPoolClientId = import.meta.env.VITE_COGNITO_USER_POOL_CLIENT_ID as string | undefined;
const authMode: 'local' | 'cognito' = import.meta.env.VITE_AUTH_MODE === 'local' ? 'local' : 'cognito';

export const appConfig = {
  apiUrl: ((import.meta.env.VITE_API_URL as string | undefined) ?? '/api').replace(/\/$/, ''),
  region: (import.meta.env.VITE_AWS_REGION as string | undefined) ?? 'us-east-1',
  authMode,
  authConfigured: authMode === 'local' || Boolean(userPoolId && userPoolClientId),
};

if (authMode === 'cognito' && userPoolId && userPoolClientId) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
      },
    },
  });
}
