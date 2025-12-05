# Kalshi Trading Dashboard

Multi-user trading dashboard with AWS Cognito authentication, portfolio tracking, analytics, QuickBets live trading, and admin capabilities.

## Live Dashboard

🔗 **https://main.d1uumqiqpqm7bm.amplifyapp.com**

## Features

- ✅ **Multi-user authentication** with AWS Cognito
- ✅ **Role-based access control** (admin vs regular users)
- ✅ **Portfolio tracking** with weighted average fill prices (live from Kalshi API)
- ✅ **Real-time position values** and current market prices
- ✅ **Trade history** with orderbook snapshots and trade parameters
- ✅ **Analytics dashboard** with equity curves and PnL by category
- ✅ **QuickBets** - Live sports betting with WebSocket price streaming
- ✅ **Mobile-responsive design** with adaptive layouts
- ✅ **Smart navigation** - market titles link to Kalshi.com, tickers link to trade details
- ✅ **Admin dashboard** with visibility to all users
- ✅ **Serverless architecture** (scalable and cost-effective)

## Pages

### Portfolio (`/dashboard`)
- **Desktop**: Sortable table with columns: Market, Ticker, Side, Contracts, Fill Price, Current Price
- **Mobile**: Card-based layout with 4-column grid (Side, Contracts, Fill, Price)
- Color-coded prices (green ≥95¢, orange ≥85¢, red <85¢)
- Hyperlinked market titles → Kalshi.com
- Hyperlinked tickers → trade details page
- Summary cards: Total Positions, Total Value, Average Position

### Trade History (`/dashboard/trades`)
- Search by market ticker (auto-search from URL: `?ticker=XXX&user_name=YYY`)
- View orderbook snapshot at trade time (perspective-adjusted bids/asks)
- Trade parameters displayed (idea_name, idea_version, idea_parameters)
- Fill details with timestamps (supports both ISO and Unix timestamps)

### Analytics (`/dashboard/analytics`)
- **Equity Curve**: Interactive area chart showing portfolio value over time
- **Period Selector**: 24h, 7d, 30d, All
- **User Selector**: Admin can switch between users
- **PnL by Category**: Horizontal bar chart with green/red coloring
- **Category Performance Table**: PnL, Volume, Win Rate per category
- Powered by Recharts library

### QuickBets (`/dashboard/quickbets`)
- **Lobby**: View available sports events (NFL, NBA, MLB, NHL, CFB, Soccer)
- **Active Sessions**: Reconnect to your running Fargate instances
- **Trading UI**: Large team cards with live prices and BUY buttons
- **Event Log**: Real-time WebSocket message logging
- **Wake Lock**: Prevents screen sleep during trading
- Launches dedicated Fargate container per user/event

### Admin (`/dashboard/admin`)
- Aggregated stats: Total Users, Total Value, Total Positions
- Per-user portfolio cards with drill-down capability
- Position details table when user selected

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 16 + React 19 + TypeScript |
| **Styling** | Tailwind CSS v4 |
| **Charts** | Recharts |
| **Auth** | AWS Cognito (User Pool + Identity Pool) |
| **Auth Client** | AWS Amplify v6 |
| **API** | API Gateway + Lambda (Python 3.12) |
| **Database** | DynamoDB (trades-v2, positions, portfolio-snapshots, settlements, market-metadata) |
| **QuickBets** | ECS Fargate + NLB + WebSocket |
| **Deployment** | AWS Amplify (auto-deploy from GitHub) |

## Project Structure

```
kalshi-dashboard/
├── app/                          # Next.js App Router
│   ├── page.tsx                  # Login page
│   ├── layout.tsx                # Root layout with AuthProvider
│   ├── globals.css               # Global styles
│   └── dashboard/
│       ├── layout.tsx            # Dashboard nav & auth check
│       ├── page.tsx              # Portfolio view
│       ├── trades/page.tsx       # Trade history lookup
│       ├── analytics/page.tsx    # Charts & PnL analysis
│       ├── quickbets/page.tsx    # Live sports trading
│       └── admin/page.tsx        # Admin multi-user view
│
├── components/
│   └── AuthProvider.tsx          # Amplify configuration wrapper
│
├── lib/
│   ├── api.ts                    # API client (getTrades, getPortfolio, getAnalytics, isAdmin)
│   └── amplify-config.ts         # Amplify config (template)
│
├── lambda/                       # Backend Lambda functions
│   ├── template.yaml             # SAM template (API Gateway + Lambdas)
│   ├── cognito.yaml              # Cognito User Pool CloudFormation
│   ├── get-portfolio.py          # Portfolio API (uses PortfolioFetcherLayer)
│   ├── get-trades.py             # Trades API (v2 schema)
│   ├── get-analytics.py          # Analytics API (settlements + categories)
│   ├── s3_config_loader.py       # Shared utility for user config
│   └── quickbets/                # QuickBets Lambda functions
│       ├── template.yaml         # QuickBets SAM template
│       ├── quickbets-events.py   # List available sports events
│       ├── quickbets-launch.py   # Launch Fargate task
│       ├── quickbets-sessions.py # Session management
│       └── quickbets-sign.py     # WebSocket auth signing
│
└── amplify/                      # Amplify Gen2 config (optional)
    ├── backend.ts
    ├── auth/resource.ts
    └── data/resource.ts
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/portfolio` | GET | Get portfolio data (admin: all users or `?user_name=X`) |
| `/portfolio?include_history=true&history_period=7d` | GET | Include equity history |
| `/trades?ticker=XXX` | GET | Get trades for ticker (admin: `&user_name=X`) |
| `/analytics?period=30d` | GET | Get PnL by category |
| `/events` | GET | QuickBets: List available sports events |
| `/launch` | POST | QuickBets: Launch Fargate for event |

## Quick Start

See [QUICKSTART.md](./QUICKSTART.md) for rapid deployment guide.
See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed infrastructure setup.

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

## Dependencies

```json
{
  "aws-amplify": "^6.15.8",
  "@aws-amplify/ui-react": "^6.13.1",
  "next": "16.0.3",
  "react": "19.2.0",
  "recharts": "^3.4.1",
  "date-fns": "^4.1.0",
  "tailwindcss": "^4"
}
```

## Authorization Model

| Role | Capabilities |
|------|-------------|
| **Regular User** (`users` group) | View own portfolio, trades, analytics |
| **Admin** (`admin` group) | View all users, aggregated stats, user drill-down |

---

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).
