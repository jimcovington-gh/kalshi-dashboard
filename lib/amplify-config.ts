// AWS Amplify Configuration
// This file should be updated after deploying Cognito and API Gateway

export const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: process.env.NEXT_PUBLIC_USER_POOL_ID || 'us-east-1_XXXXXXXXX',
      userPoolClientId: process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID || 'XXXXXXXXXXXXXXXXXXXXXXXXXX',
      identityPoolId: process.env.NEXT_PUBLIC_IDENTITY_POOL_ID || 'us-east-1:XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX',
      region: process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1',
      loginWith: {
        email: true,
      },
      userAttributes: {
        email: {
          required: true,
        },
      },
    },
  },
  API: {
    REST: {
      DashboardAPI: {
        endpoint: process.env.NEXT_PUBLIC_API_ENDPOINT || 'https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com/prod',
        region: process.env.NEXT_PUBLIC_AWS_REGION || 'us-east-1',
      },
    },
  },
};
