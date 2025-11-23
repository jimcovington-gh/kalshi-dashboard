'use client';

import { Amplify } from 'aws-amplify';
import outputs from '@/amplify_outputs.json';
import { useEffect } from 'react';

// Configure Amplify with proper structure
const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: outputs.auth.user_pool_id,
      userPoolClientId: outputs.auth.user_pool_client_id,
      identityPoolId: outputs.auth.identity_pool_id,
      region: outputs.auth.aws_region,
      loginWith: {
        email: true,
      },
    },
  },
  API: {
    REST: {
      DashboardAPI: {
        endpoint: outputs.custom.API.REST.DashboardAPI.endpoint,
        region: outputs.custom.API.REST.DashboardAPI.region,
      },
    },
  },
};

Amplify.configure(amplifyConfig, { ssr: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Configure Amplify on client-side
    Amplify.configure(amplifyConfig);
  }, []);

  return <>{children}</>;
}
