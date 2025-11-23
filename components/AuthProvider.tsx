'use client';

import { Amplify } from 'aws-amplify';
import { useEffect } from 'react';

// Configure Amplify with proper structure from amplify_outputs.json
const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: 'us-east-1_WEozUeojc',
      userPoolClientId: '6p1si912i2i95oorgruhob2il',
      identityPoolId: 'us-east-1:cd23510f-1a9a-4966-81e7-fd24601771ba',
      region: 'us-east-1',
      loginWith: {
        email: true,
      },
    },
  },
  API: {
    REST: {
      DashboardAPI: {
        endpoint: 'https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod',
        region: 'us-east-1',
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
