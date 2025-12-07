#!/bin/bash
# Kalshi Dashboard Deployment Script
# Usage: ./scripts/deploy.sh [component]
# Components: lambda, frontend, all

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASHBOARD_DIR="$(dirname "$SCRIPT_DIR")"
LAMBDA_DIR="$DASHBOARD_DIR/lambda"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Get latest portfolio fetcher layer ARN
get_portfolio_layer_arn() {
    aws lambda list-layer-versions \
        --layer-name production-kalshi-portfolio-fetcher \
        --region us-east-1 \
        --query 'LayerVersions[0].LayerVersionArn' \
        --output text
}

deploy_lambda() {
    log_info "Deploying Lambda functions via SAM..."
    
    cd "$LAMBDA_DIR"
    
    # Get the latest portfolio fetcher layer ARN
    PORTFOLIO_LAYER_ARN=$(get_portfolio_layer_arn)
    log_info "Using PortfolioFetcherLayer: $PORTFOLIO_LAYER_ARN"
    
    # Build
    log_info "Building SAM application..."
    sam build
    
    # Deploy
    log_info "Deploying SAM application..."
    sam deploy \
        --stack-name kalshi-dashboard-api \
        --parameter-overrides PortfolioFetcherLayerArn="$PORTFOLIO_LAYER_ARN" \
        --capabilities CAPABILITY_IAM \
        --no-confirm-changeset \
        --no-fail-on-empty-changeset \
        --region us-east-1 \
        --resolve-s3
    
    log_info "Lambda deployment complete!"
    
    # Show API endpoint
    API_ENDPOINT=$(aws cloudformation describe-stacks \
        --stack-name kalshi-dashboard-api \
        --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
        --output text 2>/dev/null || echo "unknown")
    log_info "API Endpoint: $API_ENDPOINT"
}

deploy_frontend() {
    log_info "Deploying frontend to Amplify..."
    
    cd "$DASHBOARD_DIR"
    
    # Check for uncommitted changes
    if [[ -n $(git status --porcelain) ]]; then
        log_warn "Uncommitted changes detected. Committing..."
        git add -A
        read -p "Enter commit message: " commit_msg
        git commit -m "${commit_msg:-Update dashboard}"
    fi
    
    # Push to trigger Amplify build
    log_info "Pushing to GitHub (triggers Amplify deployment)..."
    git push origin main
    
    # Wait for Amplify build
    log_info "Waiting for Amplify build to complete..."
    APP_ID="d1uumqiqpqm7bm"
    
    # Get latest job
    sleep 5
    JOB_ID=$(aws amplify list-jobs \
        --app-id $APP_ID \
        --branch-name main \
        --region us-east-1 \
        --max-results 1 \
        --query 'jobSummaries[0].jobId' \
        --output text)
    
    log_info "Build job: $JOB_ID"
    
    # Poll for completion
    while true; do
        STATUS=$(aws amplify get-job \
            --app-id $APP_ID \
            --branch-name main \
            --job-id $JOB_ID \
            --region us-east-1 \
            --query 'job.summary.status' \
            --output text)
        
        if [[ "$STATUS" == "SUCCEED" ]]; then
            log_info "Frontend deployment complete!"
            break
        elif [[ "$STATUS" == "FAILED" ]]; then
            log_error "Frontend deployment FAILED!"
            exit 1
        else
            echo -n "."
            sleep 10
        fi
    done
    
    log_info "Dashboard URL: https://dashboard.apexmarkets.us"
}

verify_deployment() {
    log_info "Verifying deployment..."
    
    # Test Lambda
    log_info "Testing Lambda portfolio endpoint..."
    aws lambda invoke \
        --function-name dashboard-get-portfolio \
        --cli-binary-format raw-in-base64-out \
        --payload '{"requestContext":{"authorizer":{"claims":{"cognito:username":"jimc","cognito:groups":"users","preferred_username":"jimc"}}}}' \
        --region us-east-1 \
        /tmp/verify_response.json > /dev/null 2>&1
    
    # Check for market_status in response
    if cat /tmp/verify_response.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
body = json.loads(data.get('body', '{}'))
positions = body.get('portfolio', {}).get('positions', [])
has_status = any(p.get('market_status') for p in positions)
sys.exit(0 if has_status else 1)
" 2>/dev/null; then
        log_info "✓ market_status field present in response"
    else
        log_error "✗ market_status field MISSING from response"
    fi
    
    # Check for fill_time
    if cat /tmp/verify_response.json | python3 -c "
import json, sys
data = json.load(sys.stdin)
body = json.loads(data.get('body', '{}'))
positions = body.get('portfolio', {}).get('positions', [])
has_fill_time = any(p.get('fill_time') for p in positions)
sys.exit(0 if has_fill_time else 1)
" 2>/dev/null; then
        log_info "✓ fill_time field present in response"
    else
        log_warn "✗ fill_time field not present (may not be implemented yet)"
    fi
}

show_help() {
    echo "Kalshi Dashboard Deployment Script"
    echo ""
    echo "Usage: $0 [component]"
    echo ""
    echo "Components:"
    echo "  lambda    - Deploy Lambda functions via SAM"
    echo "  frontend  - Deploy frontend via Amplify (git push)"
    echo "  all       - Deploy both Lambda and frontend"
    echo "  verify    - Verify deployment is working"
    echo ""
    echo "Examples:"
    echo "  $0 lambda     # Deploy just the Lambda functions"
    echo "  $0 frontend   # Deploy just the frontend"
    echo "  $0 all        # Deploy everything"
    echo "  $0 verify     # Check deployment is working"
}

# Main
case "${1:-help}" in
    lambda)
        deploy_lambda
        verify_deployment
        ;;
    frontend)
        deploy_frontend
        ;;
    all)
        deploy_lambda
        deploy_frontend
        verify_deployment
        ;;
    verify)
        verify_deployment
        ;;
    help|--help|-h)
        show_help
        ;;
    *)
        log_error "Unknown component: $1"
        show_help
        exit 1
        ;;
esac
