# Kalshi Dashboard - Quick Start

## What's Been Built

A production-ready, multi-user trading dashboard with:

✅ **Multi-user authentication** (AWS Cognito)
✅ **Role-based access control** (admin vs regular users)
✅ **Portfolio tracking** (real-time positions & values with fill prices)
✅ **Trade history lookup** (with order book snapshots)
✅ **Analytics dashboard** (equity curves, PnL by category)
✅ **QuickBets** (live sports trading with WebSocket)
✅ **Admin dashboard** (view all users)
✅ **Responsive UI** (mobile-optimized with adaptive layouts)
✅ **Serverless architecture** (API Gateway + Lambda)
✅ **Smart navigation** (hyperlinked markets & tickers)

## Project Structure

```
kalshi-dashboard/
├── app/                          # Next.js App Router (frontend)
│   ├── page.tsx                  # Login page
│   ├── layout.tsx                # Root layout + AuthProvider
│   └── dashboard/
│       ├── layout.tsx            # Nav bar + auth check
│       ├── page.tsx              # Portfolio view (user's own)
│       ├── trades/page.tsx       # Trade lookup by ticker
│       ├── analytics/page.tsx    # Equity curves + PnL charts
│       ├── quickbets/page.tsx    # Live sports trading
│       └── admin/page.tsx        # Admin view (all users)
│
├── components/
│   └── AuthProvider.tsx          # Amplify v6 configuration
│
├── lib/
│   ├── api.ts                    # API client functions
│   └── amplify-config.ts         # Config template
│
├── lambda/                       # Backend infrastructure
│   ├── template.yaml             # SAM template (API + Lambdas)
│   ├── cognito.yaml              # Cognito user pool config
│   ├── get-portfolio.py          # Portfolio API (+ PortfolioFetcherLayer)
│   ├── get-trades.py             # Trades API (v2 schema)
│   ├── get-analytics.py          # Analytics API (settlements)
│   ├── s3_config_loader.py       # Shared utility
│   └── quickbets/                # QuickBets Lambda functions
│       ├── template.yaml
│       ├── quickbets-events.py   # List sports events
│       └── quickbets-launch.py   # Launch Fargate task
│
└── amplify/                      # Amplify Gen2 (optional)
    ├── backend.ts
    ├── auth/resource.ts
    └── data/resource.ts
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
USER_POOL_ID=us-east-1_WEozUeojc

# Create admin
aws cognito-idp admin-create-user \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS

# Set password
aws cognito-idp admin-set-user-password \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --password YourPassword123! \
  --permanent

# IMPORTANT: Set preferred_username to match trading system user_name
aws cognito-idp admin-update-user-attributes \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --user-attributes Name=preferred_username,Value=admin

# Add to admin group
aws cognito-idp admin-add-user-to-group \
  --user-pool-id $USER_POOL_ID \
  --username admin@example.com \
  --group-name admin
```

### 4. Configure Frontend
Update `components/AuthProvider.tsx` with Cognito and API values.

### 5. Run Locally
```bash
npm install
npm run dev
# Visit http://localhost:3000
```

### 6. Deploy to Production
```bash
git add .
git commit -m "Your changes"
git push origin main
# Amplify auto-deploys from GitHub
```

## Features Comparison

| Feature | Simple Flask | This Solution |
|---------|--------------|---------------|
| Multi-user auth | ❌ | ✅ Cognito |
| Role-based access | ❌ | ✅ Admin/Users |
| Scalability | 1 server | ♾️ Serverless |
| Mobile responsive | ⚠️ Basic HTML | ✅ Adaptive UI |
| Fill price tracking | ❌ | ✅ Weighted avg |
| Smart navigation | ❌ | ✅ Hyperlinks |
| Analytics/Charts | ❌ | ✅ Recharts |
| Live trading | ❌ | ✅ QuickBets |
| Component reuse | ❌ | ✅ React |
| Future expansion | Hard | Easy |
| Production ready | ❌ | ✅ |

## Authorization Model

**Regular User (e.g., jimc)**
- ✅ View own portfolio
- ✅ View own trades
- ✅ View own analytics
- ✅ Use QuickBets
- ❌ Cannot see other users

**Admin User**
- ✅ View ALL users' portfolios
- ✅ View ALL users' trades  
- ✅ View ALL users' analytics
- ✅ Admin dashboard with aggregated stats
- ✅ Per-user drill-down
- ✅ User selector in analytics

## API Endpoints

### GET /portfolio
- **User**: Returns own portfolio with positions
- **Admin**: Returns all users (or specific user if `?user_name=X`)
- **History**: Add `?include_history=true&history_period=7d`

### GET /trades?ticker=XXX
- **User**: Returns own trades for that ticker
- **Admin**: Returns all trades (or specific user if `?user_name=X`)

### GET /analytics?period=30d
- **User**: Returns own PnL by category
- **Admin**: Can query any user with `?user_name=X`

### QuickBets API (separate stack)
- **GET /events**: Available sports events
- **POST /launch**: Launch Fargate for event

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16 + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| Charts | Recharts |
| Auth | AWS Cognito |
| Auth Client | AWS Amplify v6 |
| API | API Gateway + Lambda |
| Database | DynamoDB (multiple tables) |
| QuickBets | ECS Fargate + NLB |
| Deployment | AWS Amplify |
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

## Production URLs

- **Dashboard**: https://main.d1uumqiqpqm7bm.amplifyapp.com
- **API**: https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod
- **QuickBets API**: https://5uthw49k2c.execute-api.us-east-1.amazonaws.com/prod
- **QuickBets WebSocket**: wss://quickbets.apexmarkets.us

## Next Steps

1. Deploy Cognito + API (15 min)
2. Create users with correct `preferred_username` (5 min)
3. Test locally (5 min)
4. Deploy to Amplify (10 min)
5. Start trading! 🚀

See `DEPLOYMENT.md` for detailed instructions.
