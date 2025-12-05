# Kalshi Trading Dashboard - Deployment Guide

Multi-user trading dashboard with AWS Cognito authentication, portfolio tracking, analytics, QuickBets live trading, and admin capabilities.

## Architecture

### Frontend
- **Framework**: Next.js 16 with React 19 + TypeScript
- **Styling**: Tailwind CSS v4
- **Charts**: Recharts
- **Authentication**: AWS Amplify v6 + Cognito
- **Deployment**: AWS Amplify Hosting (auto-deploy from GitHub)

### Backend
- **API**: API Gateway + Lambda (Python 3.12) with SAM
- **Authentication**: Cognito User Pool with JWT tokens
- **Authorization**: User groups (admin, users)
- **Data**: DynamoDB tables:
  - `production-kalshi-trades-v2` - Trade history with v2 schema
  - `production-kalshi-market-positions` - Current positions
  - `production-kalshi-portfolio-snapshots` - Historical equity data
  - `production-kalshi-settlements` - Settlement/PnL data
  - `production-kalshi-market-metadata` - Market titles, categories
  - `production-kalshi-quickbets-sessions` - QuickBets session tracking

### QuickBets Infrastructure
- **Compute**: ECS Fargate (per-user containers)
- **Load Balancer**: NLB with WebSocket support
- **Session Table**: DynamoDB with TTL
- **WebSocket URL**: `wss://quickbets.apexmarkets.us`

### Features
- ✅ Multi-user support with isolated data access
- ✅ Admin dashboard with visibility to all users
- ✅ Real-time portfolio tracking with weighted average fill prices
- ✅ Trade history lookup with orderbook snapshots
- ✅ Analytics with equity curves and PnL by category
- ✅ QuickBets live sports trading
- ✅ Responsive design (mobile-friendly with adaptive layouts)
- ✅ Hyperlinked market titles to Kalshi.com
- ✅ Hyperlinked tickers to trade detail pages

## Step-by-Step Deployment

### Step 1: Deploy Cognito User Pool

```bash
cd lambda

# Deploy Cognito stack
aws cloudformation create-stack \
  --stack-name kalshi-dashboard-cognito \
  --template-body file://cognito.yaml \
  --capabilities CAPABILITY_IAM

# Wait for completion
aws cloudformation wait stack-create-complete --stack-name kalshi-dashboard-cognito

# Get outputs
aws cloudformation describe-stacks --stack-name kalshi-dashboard-cognito --query 'Stacks[0].Outputs'
```

Save these outputs:
- `UserPoolId` (e.g., `us-east-1_WEozUeojc`)
- `UserPoolClientId` (e.g., `6p1si912i2i95oorgruhob2il`)
- `IdentityPoolId` (e.g., `us-east-1:cd23510f-1a9a-4966-81e7-fd24601771ba`)
- `UserPoolArn`

### Step 2: Deploy API Gateway + Lambdas

The dashboard uses SAM (Serverless Application Model) for deployment:

```bash
cd lambda

# Build Lambda functions
sam build

# Deploy with guided prompts (first time)
sam deploy --guided \
  --stack-name kalshi-dashboard-api \
  --parameter-overrides \
    CognitoUserPoolArn=arn:aws:cognito-idp:us-east-1:XXXXX:userpool/us-east-1_XXXXX \
    PortfolioFetcherLayerArn=arn:aws:lambda:us-east-1:XXXXX:layer:portfolio-fetcher:X \
  --capabilities CAPABILITY_IAM

# Or deploy with saved config
sam deploy

# Get API endpoint
aws cloudformation describe-stacks --stack-name kalshi-dashboard-api \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' --output text
```

**Lambda Functions Deployed:**
- `dashboard-get-portfolio` - Portfolio data with live API fetch + DynamoDB enrichment
- `dashboard-get-trades` - Trade history from v2 trades table
- `dashboard-get-analytics` - PnL by category from settlements table

**Required Layers:**
- `dashboard-shared-code` - Contains `s3_config_loader.py`
- `PortfolioFetcherLayer` - From kalshi-market-capture stack (for live API calls)

### Step 3: Deploy QuickBets API (Optional)

```bash
cd lambda/quickbets

sam build
sam deploy --guided --stack-name kalshi-quickbets-api

# This creates:
# - GET /events - List available sports events
# - POST /launch - Launch Fargate task for event
# - GET /sessions - Manage user sessions
```

### Step 4: Create Cognito Users

```bash
# Get User Pool ID
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name kalshi-dashboard-cognito \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)

# Create admin user
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS

# Set password (permanent)
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --password TempPassword123! \
  --permanent

# Add to admin group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --group-name admin

# Set preferred_username (maps to DynamoDB user_name)
aws cognito-idp admin-update-user-attributes \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --user-attributes Name=preferred_username,Value=admin

# Create regular user (repeat for each trading user)
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username jimc@example.com \
  --user-attributes Name=email,Value=jimc@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username jimc@example.com \
  --password UserPassword123! \
  --permanent

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username jimc@example.com \
  --group-name users

# IMPORTANT: Set preferred_username to match the trading system user_name
aws cognito-idp admin-update-user-attributes \
  --user-pool-id $USER_POOL_ID \
  --username jimc@example.com \
  --user-attributes Name=preferred_username,Value=jimc
```

### Step 5: Configure Frontend

Update `components/AuthProvider.tsx` with your values:

```typescript
const amplifyConfig = {
  Auth: {
    Cognito: {
      userPoolId: 'us-east-1_WEozUeojc',           // From Step 1
      userPoolClientId: '6p1si912i2i95oorgruhob2il', // From Step 1
      identityPoolId: 'us-east-1:cd23510f-...',     // From Step 1
      region: 'us-east-1',
      loginWith: { email: true },
    },
  },
  API: {
    REST: {
      DashboardAPI: {
        endpoint: 'https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod', // From Step 2
        region: 'us-east-1',
      },
    },
  },
};
```

Or use environment variables in `.env.local`:

```bash
NEXT_PUBLIC_USER_POOL_ID=us-east-1_WEozUeojc
NEXT_PUBLIC_USER_POOL_CLIENT_ID=6p1si912i2i95oorgruhob2il
NEXT_PUBLIC_IDENTITY_POOL_ID=us-east-1:cd23510f-1a9a-4966-81e7-fd24601771ba
NEXT_PUBLIC_API_ENDPOINT=https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod
NEXT_PUBLIC_AWS_REGION=us-east-1
```

### Step 6: Test Locally

```bash
npm install
npm run dev
# Visit http://localhost:3000
```

### Step 7: Deploy Frontend to AWS Amplify

**IMPORTANT:** The dashboard is hosted on AWS Amplify. Any changes to the frontend code (pages, components, styles) must be committed and pushed to Git to trigger a deployment. Changes will NOT be visible to users until deployed.

```bash
# After making changes to dashboard code:
git add .
git commit -m "Description of changes"
git push origin main

# Amplify will automatically detect the push and deploy
# Monitor deployment at: https://console.aws.amazon.com/amplify/
# Or check: aws amplify list-jobs --app-id d1uumqiqpqm7bm --branch-name main
```

**Current Production URLs:**
- Dashboard: https://main.d1uumqiqpqm7bm.amplifyapp.com
- API: https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod
- QuickBets API: https://5uthw49k2c.execute-api.us-east-1.amazonaws.com/prod
- QuickBets WebSocket: wss://quickbets.apexmarkets.us

## Authorization Model

### Regular Users (`users` group)
- View own portfolio only
- View own trades only
- View own analytics only
- Access QuickBets for own trading

### Admins (`admin` group)
- View all users' portfolios (aggregated view)
- View all users' trades
- View all users' analytics
- Access admin dashboard with per-user drill-down
- Switch between users in analytics view

## User Management

### Add New User
```bash
USER_POOL_ID=us-east-1_WEozUeojc

aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username newuser@example.com \
  --user-attributes Name=email,Value=newuser@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username newuser@example.com \
  --password SecurePass123! \
  --permanent

# IMPORTANT: Set preferred_username to match trading system user_name
aws cognito-idp admin-update-user-attributes \
  --user-pool-id $USER_POOL_ID \
  --username newuser@example.com \
  --user-attributes Name=preferred_username,Value=newuser

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username newuser@example.com \
  --group-name users
```

### Promote to Admin
```bash
aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username user@example.com \
  --group-name admin
```

### List Users
```bash
aws cognito-idp list-users --user-pool-id $USER_POOL_ID
```

### Delete User
```bash
aws cognito-idp admin-delete-user \
  --user-pool-id $USER_POOL_ID \
  --username user@example.com
```

## DynamoDB Tables

| Table | Primary Key | GSI | Purpose |
|-------|-------------|-----|---------|
| `production-kalshi-trades-v2` | `order_id` | `market_ticker-index`, `user_name-index` | Trade history |
| `production-kalshi-market-positions` | `ticker` | - | Current positions |
| `production-kalshi-portfolio-snapshots` | `api_key_id`, `snapshot_ts` | - | Equity history |
| `production-kalshi-settlements` | `ticker`, `api_key_id` | `UserSettlementIndex` | PnL data |
| `production-kalshi-market-metadata` | `market_ticker` | - | Market titles, categories |
| `production-kalshi-quickbets-sessions` | `event_ticker` | - | QuickBets sessions |

## Monitoring

```bash
# Lambda logs
aws logs tail /aws/lambda/dashboard-get-trades --follow
aws logs tail /aws/lambda/dashboard-get-portfolio --follow
aws logs tail /aws/lambda/dashboard-get-analytics --follow

# QuickBets logs
aws logs tail /aws/lambda/quickbets-events --follow
aws logs tail /aws/lambda/quickbets-launch --follow

# Amplify build logs
aws amplify list-jobs --app-id d1uumqiqpqm7bm --branch-name main
```

## Cleanup

```bash
# Delete Amplify app (careful - this deletes everything!)
amplify delete

# Delete API stacks
aws cloudformation delete-stack --stack-name kalshi-dashboard-api
aws cloudformation delete-stack --stack-name kalshi-quickbets-api
aws cloudformation delete-stack --stack-name kalshi-dashboard-cognito
```

## Troubleshooting

### "Access denied" errors
- Check that `preferred_username` in Cognito matches the `user_name` in DynamoDB tables
- Verify user is in correct group (`admin` or `users`)

### Portfolio shows 0 positions
- Check Lambda logs for PortfolioFetcherLayer errors
- Verify Kalshi API credentials in Secrets Manager

### Analytics shows no data
- Check that settlements exist in `production-kalshi-settlements` table
- Verify `api_key_id` matches between portfolio and settlements

### QuickBets not connecting
- Check Fargate task is running in ECS console
- Verify NLB target group health checks
- Check security group allows WebSocket traffic (port 8765)
