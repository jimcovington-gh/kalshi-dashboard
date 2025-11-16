# Kalshi Dashboard - Quick Start

## What's Been Built

A production-ready, multi-user trading dashboard with:

✅ **Multi-user authentication** (AWS Cognito)
✅ **Role-based access control** (admin vs regular users)
✅ **Portfolio tracking** (real-time positions & values)
✅ **Trade history lookup** (with order book snapshots)
✅ **Admin dashboard** (view all users)
✅ **Responsive UI** (mobile-friendly)
✅ **Serverless architecture** (API Gateway + Lambda)

## Project Structure

```
kalshi-dashboard/
├── app/                          # Next.js frontend
│   ├── page.tsx                  # Login page
│   └── dashboard/
│       ├── page.tsx              # Portfolio view (user's own)
│       ├── trades/page.tsx       # Trade lookup by ticker
│       └── admin/page.tsx        # Admin view (all users)
│
├── lambda/                       # Backend infrastructure
│   ├── get-trades.py            # Lambda: Query trades
│   ├── get-portfolio.py         # Lambda: Get portfolio data
│   ├── template.yaml            # SAM template (API + Lambdas)
│   └── cognito.yaml             # Cognito user pool config
│
├── lib/
│   ├── api.ts                   # API client functions
│   └── amplify-config.ts        # AWS Amplify settings
│
└── components/
    └── AuthProvider.tsx         # Auth configuration wrapper
```

## Quick Deploy

### 1. Deploy Cognito
```bash
cd lambda
aws cloudformation create-stack \
  --stack-name kalshi-dashboard-cognito \
  --template-body file://cognito.yaml \
  --capabilities CAPABILITY_IAM
```

### 2. Deploy API
```bash
sam build
sam deploy --guided --stack-name kalshi-dashboard-api
```

### 3. Create Users
```bash
# Get User Pool ID from CloudFormation outputs
USER_POOL_ID=...

# Create admin
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com

# Add to admin group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --group-name admin
```

### 4. Configure Frontend
Copy `.env.example` to `.env.local` and fill in values from CloudFormation outputs.

### 5. Run Locally
```bash
npm install
npm run dev
# Visit http://localhost:3000
```

### 6. Deploy to Production
```bash
amplify init
amplify add hosting
amplify publish
```

## Features Comparison

| Feature | Simple Flask | This Solution |
|---------|--------------|---------------|
| Multi-user auth | ❌ | ✅ Cognito |
| Role-based access | ❌ | ✅ Admin/Users |
| Scalability | 1 server | ♾️ Serverless |
| Mobile responsive | ⚠️ Basic HTML | ✅ Tailwind |
| Component reuse | ❌ | ✅ React |
| Future expansion | Hard | Easy |
| Production ready | ❌ | ✅ |

## Authorization Model

**Regular User (e.g., jimc)**
- ✅ View own portfolio
- ✅ View own trades
- ❌ Cannot see other users

**Admin User**
- ✅ View ALL users' portfolios
- ✅ View ALL users' trades  
- ✅ Admin dashboard with aggregated stats
- ✅ Per-user drill-down

## API Endpoints

### GET /portfolio
- **User**: Returns own portfolio
- **Admin**: Returns all users (or specific user if `?user_name=X`)

### GET /trades?ticker=XXX
- **User**: Returns own trades for that ticker
- **Admin**: Returns all trades (or specific user if `?user_name=X`)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 + TypeScript |
| Styling | Tailwind CSS |
| Auth | AWS Cognito |
| API | API Gateway + Lambda |
| Database | DynamoDB (existing tables) |
| Deployment | AWS Amplify / S3+CloudFront |
| Language | TypeScript + Python 3.12 |

## What Makes This Better

### vs Flask + HTML:
- **Scalable**: Auto-scales with serverless
- **Secure**: Built-in Cognito auth with JWT
- **Maintainable**: Component-based React
- **Extensible**: Easy to add new pages/features
- **Production-ready**: Proper auth, CORS, logging

### vs Building from Scratch:
- **Faster**: Pre-built auth UI with Amplify
- **Cheaper**: Pay-per-use (not always-on server)
- **Integrated**: Works with existing DynamoDB tables
- **Monitored**: CloudWatch logs built-in

## Next Steps

1. Deploy Cognito + API (15 min)
2. Create users (5 min)
3. Test locally (5 min)
4. Deploy to Amplify (10 min)
5. Start trading! 🚀

See `DEPLOYMENT.md` for detailed instructions.
