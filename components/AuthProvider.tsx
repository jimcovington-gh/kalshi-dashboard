'use client';

import { Amplify } from 'aws-amplify';
import { amplifyConfig } from '@/lib/amplify-config';
import { useEffect } from 'react';

Amplify.configure(amplifyConfig, { ssr: true });

export function AuthProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    // Configure Amplify on client-side
    Amplify.configure(amplifyConfig);
  }, []);

  return <>{children}</>;
}
