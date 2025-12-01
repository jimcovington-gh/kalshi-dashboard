# Kalshi Trading Dashboard - Deployment Guide

Multi-user trading dashboard with AWS Cognito authentication, portfolio tracking, and admin capabilities.

## Architecture

### Frontend
- **Framework**: Next.js 16 with TypeScript
- **Styling**: Tailwind CSS
- **Authentication**: AWS Amplify + Cognito
- **Deployment**: AWS Amplify Hosting (or S3 + CloudFront)

### Backend
- **API**: API Gateway + Lambda (Python 3.12)
- **Authentication**: Cognito User Pool with JWT tokens
- **Authorization**: User groups (admin, users)
- **Data**: DynamoDB tables (positions, trades, portfolio snapshots)

### Features
- ✅ Multi-user support with isolated data access
- ✅ Admin dashboard with visibility to all users
- ✅ Real-time portfolio tracking with weighted average fill prices
- ✅ Trade history lookup by market ticker
- ✅ Order book snapshots
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
- `UserPoolId`
- `UserPoolClientId`
- `IdentityPoolId`
- `UserPoolArn`

### Step 2: Deploy API Gateway + Lambdas

```bash
# Update template.yaml with Cognito User Pool ARN from Step 1

# Build and deploy with SAM
sam build
sam deploy --guided \
  --stack-name kalshi-dashboard-api \
  --parameter-overrides CognitoUserPoolArn=arn:aws:cognito-idp:us-east-1:XXXXX:userpool/us-east-1_XXXXX \
  --capabilities CAPABILITY_IAM

# Get API endpoint
aws cloudformation describe-stacks --stack-name kalshi-dashboard-api \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' --output text
```

### Step 3: Create Cognito Users

```bash
# Get User Pool ID
USER_POOL_ID=$(aws cloudformation describe-stacks --stack-name kalshi-dashboard-cognito \
  --query 'Stacks[0].Outputs[?OutputKey==`UserPoolId`].OutputValue' --output text)

# Create admin user
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true

# Set password
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

# Create regular user
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username jimc@example.com \
  --user-attributes Name=email,Value=jimc@example.com Name=email_verified,Value=true

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username jimc@example.com \
  --password UserPassword123! \
  --permanent

aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username jimc@example.com \
  --group-name users
```

### Step 4: Configure Frontend

Create `.env.local`:

```bash
NEXT_PUBLIC_USER_POOL_ID=us-east-1_XXXXXXXXX
NEXT_PUBLIC_USER_POOL_CLIENT_ID=XXXXXXXXXXXXXXXXXXXXXXXXXX
NEXT_PUBLIC_IDENTITY_POOL_ID=us-east-1:XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX
NEXT_PUBLIC_API_ENDPOINT=https://XXXXXXXXXX.execute-api.us-east-1.amazonaws.com/prod
NEXT_PUBLIC_AWS_REGION=us-east-1
```

### Step 5: Test Locally

```bash
npm install
npm run dev
# Visit http://localhost:3000
```

### Step 6: Deploy Frontend to AWS Amplify

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

To deploy manually:

```bash
# Install Amplify CLI
npm install -g @aws-amplify/cli

# Initialize
amplify init

# Add hosting
amplify add hosting
# Select: Hosting with Amplify Console (Managed hosting)

# Publish
amplify publish
```

## Authorization Model

### Regular Users (`users` group)
- View own portfolio only
- View own trades only

### Admins (`admin` group)
- View all users' portfolios
- View all users' trades
- Access admin dashboard with aggregated stats

## User Management

### Add New User
```bash
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username newuser@example.com \
  --user-attributes Name=email,Value=newuser@example.com

aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username newuser@example.com \
  --password SecurePass123! \
  --permanent

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

## Monitoring

```bash
# Lambda logs
aws logs tail /aws/lambda/dashboard-get-trades --follow
aws logs tail /aws/lambda/dashboard-get-portfolio --follow

# API Gateway logs in CloudWatch
```

## Cleanup

```bash
amplify delete
aws cloudformation delete-stack --stack-name kalshi-dashboard-api
aws cloudformation delete-stack --stack-name kalshi-dashboard-cognito
```
