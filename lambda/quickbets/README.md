# QuickBets API Deployment

This directory contains the QuickBets API Lambda functions that power real-time sports trading on Kalshi.

## Architecture

- **API Gateway**: REST API with Cognito authentication
- **Lambda Functions**:
  - `quickbets-events`: Fetches available sports events from Kalshi API
  - `quickbets-launch`: Launches Fargate tasks for trading sessions
  - `quickbets-sessions`: Manages active user sessions
  - `quickbets-sign`: Signs Kalshi API requests with RSA-PSS
- **Lambda Layer**: `CryptoLayer` with `cryptography` library for RSA signing

## Dependencies

The QuickBets API requires the `cryptography` Python library for signing Kalshi API requests. This is packaged as a Lambda Layer to ensure consistent deployments.

### Critical: CryptoLayer Must Be Attached

The following functions **MUST** have the `CryptoLayer` attached in `template.yaml`:
- `QuickBetsEventsFunction` - Uses cryptography for API signing
- `QuickBetsLaunchFunction` - Uses cryptography for API signing  
- `QuickBetsSignFunction` - Uses cryptography for API signing

**If the layer is missing, you will see errors like:**
```
[ERROR] Runtime.ImportModuleError: Unable to import module 'quickbets-events': No module named 'cryptography'
```

## Deployment

### Quick Deploy

```bash
./deploy.sh
```

This script will:
1. Verify the cryptography layer exists
2. Check template configuration
3. Build the SAM application (with Docker)
4. Deploy to AWS (stack: `quickbets-api`)
5. Verify all Lambda functions
6. Test the API endpoint
7. Check for errors in logs

### Manual Deploy

```bash
# Build
sam build --use-container

# Deploy
sam deploy \
  --stack-name quickbets-api \
  --capabilities CAPABILITY_IAM \
  --no-confirm-changeset \
  --resolve-s3
```

### Rebuild Cryptography Layer

If you need to rebuild the cryptography layer (e.g., for a new Python version):

```bash
cd layer
pip3 install -r requirements.txt \
  -t . \
  --platform manylinux2014_x86_64 \
  --only-binary=:all: \
  --python-version 3.12
```

## Configuration

### Environment Variables

Set in `template.yaml` for each function:

- `SESSIONS_TABLE`: DynamoDB table for tracking user sessions
- `KALSHI_API_BASE_URL`: Kalshi API endpoint
- `USER_SECRET_PREFIX`: Secrets Manager prefix for user API keys
- `ECS_CLUSTER`: Fargate cluster name
- `TASK_DEFINITION`: Fargate task definition
- `WEBSOCKET_URL`: WebSocket URL for trading clients

### AWS Resources

The API requires permissions for:
- DynamoDB: Read/write sessions table
- Secrets Manager: Read user API keys
- ECS: Run and manage Fargate tasks
- Elastic Load Balancing: Register/deregister targets

## Troubleshooting

### "Failed to fetch" error in frontend

**Symptoms**: QuickBets lobby shows "Loading available events..." then "Error: Failed to fetch"

**Cause**: Lambda function failed to start due to missing dependencies (typically `cryptography`)

**Solution**: 
1. Check Lambda logs: `aws logs tail /aws/lambda/quickbets-events --follow`
2. If you see `ImportModuleError: No module named 'cryptography'`, redeploy:
   ```bash
   ./deploy.sh
   ```

### "Unauthorized" response

This is **expected** behavior when testing without authentication. The API requires a valid Cognito JWT token.

### Layer not attaching

If the deployment succeeds but the layer isn't attached:
1. Check `template.yaml` has `Layers: [!Ref CryptoLayer]` for each function
2. Verify the layer builds successfully in SAM output
3. Check Lambda console to see if layer is attached

## API Endpoints

- `GET /events` - List available sports events
- `POST /launch` - Launch Fargate task for an event
- `GET /sessions` - Get active user sessions
- `POST /sign` - Sign Kalshi API request

All endpoints require Cognito authentication except OPTIONS (CORS preflight).

## Stack Information

- **Stack Name**: `quickbets-api`
- **Region**: `us-east-1`
- **API Endpoint**: https://5uthw49k2c.execute-api.us-east-1.amazonaws.com/prod

## Related Resources

- Main dashboard: `../../` (Next.js frontend)
- Main dashboard API: `../` (portfolio, trades, analytics)
- Fargate tasks: `kalshi-market-capture` repository
