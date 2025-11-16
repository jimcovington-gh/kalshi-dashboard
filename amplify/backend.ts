import { defineBackend } from '@aws-amplify/backend';

/**
 * Using existing Cognito User Pool and API Gateway
 * No need for Amplify-managed backend resources
 */
defineBackend({
  // We're using existing AWS resources (Cognito + API Gateway)
  // Configuration is in amplify_outputs.json
});
