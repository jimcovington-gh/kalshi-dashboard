# Kalshi Trading Dashboard

Multi-user trading dashboard with AWS Cognito authentication, portfolio tracking, and admin capabilities.

## Live Dashboard

🔗 **https://main.d1uumqiqpqm7bm.amplifyapp.com**

## Features

- ✅ **Multi-user authentication** with AWS Cognito
- ✅ **Role-based access control** (admin vs regular users)
- ✅ **Portfolio tracking** with weighted average fill prices
- ✅ **Real-time position values** and current market prices
- ✅ **Trade history** with orderbook snapshots
- ✅ **Mobile-responsive design** with adaptive layouts
- ✅ **Smart navigation** - market titles link to Kalshi.com, tickers link to trade details
- ✅ **Admin dashboard** with visibility to all users
- ✅ **Serverless architecture** (scalable and cost-effective)

## Portfolio View

### Desktop Layout
- Sortable table with columns: Market, Ticker, Side, Contracts, **Fill Price**, Current Price
- Color-coded prices (green for deep ITM/OTM, orange for moderate, red for close)
- Hyperlinked market titles (→ Kalshi.com)
- Hyperlinked tickers (→ trade details page)

### Mobile Layout
- Card-based layout optimized for small screens
- 4-column grid: Side, Contracts, Fill, Price
- Compact navigation header
- Touch-friendly interface

## Trade History

- Search by market ticker
- Auto-search from URL parameter (`?ticker=XXX`)
- View orderbook snapshot at trade time
- See fill details and execution timestamps
- Mobile-responsive with stacked layouts

## Tech Stack

- **Frontend**: Next.js 16 + TypeScript + Tailwind CSS
- **Backend**: AWS Lambda (Python 3.12) + API Gateway
- **Auth**: AWS Cognito with JWT tokens
- **Data**: DynamoDB (positions, trades, portfolio snapshots, market metadata)
- **Deployment**: AWS Amplify (auto-deploy from GitHub)

## Quick Start

See [QUICKSTART.md](./QUICKSTART.md) for rapid deployment guide.
See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed infrastructure setup.

## Development

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser.

## Recent Updates

- **Fill Price Tracking**: Shows weighted average fill price for each position
- **Mobile Optimization**: Fully responsive with adaptive layouts and compact navigation
- **Smart Navigation**: Hyperlinked markets and tickers for quick access
- **IAM Permissions**: Lambda access to trades table for fill price calculations

---

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).
