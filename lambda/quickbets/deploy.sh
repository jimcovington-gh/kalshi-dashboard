#!/bin/bash
# QuickBets API Deployment Script
# Ensures all dependencies are properly packaged and deployed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

# Verify we're in the right directory
if [[ ! -f "template.yaml" ]]; then
    log_error "template.yaml not found. Run this script from lambda/quickbets/"
    exit 1
fi

# Step 1: Verify cryptography layer exists
log_step "Verifying cryptography layer dependencies..."
if [[ ! -f "layer/requirements.txt" ]]; then
    log_error "layer/requirements.txt not found"
    exit 1
fi

if [[ ! -d "layer/cryptography" ]]; then
    log_warn "Cryptography library not found in layer/, installing..."
    
    # Install cryptography into layer
    mkdir -p layer
    pip3 install -r layer/requirements.txt -t layer/ --platform manylinux2014_x86_64 --only-binary=:all: --python-version 3.12
    
    log_info "✓ Cryptography installed to layer/"
else
    log_info "✓ Cryptography layer exists"
fi

# Step 2: Verify template has CryptoLayer attached to all functions that need it
log_step "Verifying template configuration..."

# Check if QuickBetsEventsFunction has Layers
if ! grep -A 10 "QuickBetsEventsFunction:" template.yaml | grep -q "Layers:"; then
    log_warn "QuickBetsEventsFunction missing Layers configuration"
    log_info "This will be fixed in the template"
fi

# Check if QuickBetsLaunchFunction has Layers
if ! grep -A 10 "QuickBetsLaunchFunction:" template.yaml | grep -q "Layers:"; then
    log_warn "QuickBetsLaunchFunction missing Layers configuration"
    log_info "This will be fixed in the template"
fi

# Step 3: Build SAM application
# NOTE: Removed --use-container flag on 2023-12-23 to speed up builds.
# The cryptography layer already contains pre-compiled manylinux2014_x86_64 binaries,
# so container builds are unnecessary. If you see "invalid ELF header" or similar
# architecture errors after deployment, revert to: sam build --use-container
log_step "Building SAM application..."
sam build --parallel --cached

if [[ $? -ne 0 ]]; then
    log_error "SAM build failed"
    exit 1
fi

log_info "✓ Build successful"

# Step 4: Deploy to AWS
log_step "Deploying to AWS..."
sam deploy \
    --stack-name quickbets-api \
    --capabilities CAPABILITY_IAM \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset \
    --resolve-s3 \
    --region us-east-1

if [[ $? -ne 0 ]]; then
    log_error "Deployment failed"
    exit 1
fi

log_info "✓ Deployment successful"

# Step 5: Get API endpoint
log_step "Retrieving API endpoint..."
API_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name quickbets-api \
    --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' \
    --output text 2>/dev/null)

if [[ -n "$API_ENDPOINT" ]]; then
    log_info "✓ API Endpoint: $API_ENDPOINT"
else
    log_warn "Could not retrieve API endpoint"
fi

# Step 6: Verify Lambda functions
log_step "Verifying Lambda functions..."

for func in quickbets-events quickbets-launch quickbets-sessions quickbets-sign; do
    if aws lambda get-function --function-name $func --region us-east-1 >/dev/null 2>&1; then
        log_info "✓ $func exists"
        
        # Check if function has layers (for events and sign which need crypto)
        if [[ "$func" == "quickbets-events" ]] || [[ "$func" == "quickbets-sign" ]]; then
            LAYER_COUNT=$(aws lambda get-function-configuration \
                --function-name $func \
                --region us-east-1 \
                --query 'length(Layers)' \
                --output text 2>/dev/null)
            
            if [[ "$LAYER_COUNT" -gt 0 ]]; then
                log_info "  ✓ Has $LAYER_COUNT layer(s) attached"
            else
                log_error "  ✗ No layers attached (cryptography dependency missing!)"
                exit 1
            fi
        fi
    else
        log_error "✗ $func not found"
        exit 1
    fi
done

# Step 7: Test the /events endpoint
log_step "Testing /events endpoint..."
log_info "Attempting to fetch events (will show 'Unauthorized' if auth is required - this is expected)"

TEST_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" "$API_ENDPOINT/events" 2>/dev/null || echo "000")

if [[ "$TEST_RESPONSE" == "401" ]]; then
    log_info "✓ Endpoint responding (requires authentication)"
elif [[ "$TEST_RESPONSE" == "200" ]]; then
    log_info "✓ Endpoint responding successfully"
elif [[ "$TEST_RESPONSE" == "000" ]]; then
    log_warn "Could not reach endpoint (may need DNS propagation)"
else
    log_warn "Unexpected response code: $TEST_RESPONSE"
fi

# Step 8: Check recent Lambda logs for errors
log_step "Checking recent Lambda logs for errors..."
RECENT_ERRORS=$(aws logs filter-log-events \
    --log-group-name /aws/lambda/quickbets-events \
    --start-time $(date -d '5 minutes ago' +%s)000 \
    --filter-pattern "ERROR" \
    --region us-east-1 \
    --query 'events[*].message' \
    --output text 2>/dev/null)

if [[ -n "$RECENT_ERRORS" ]]; then
    log_error "Recent errors found in logs:"
    echo "$RECENT_ERRORS"
    exit 1
else
    log_info "✓ No recent errors in Lambda logs"
fi

echo ""
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_info "  QuickBets API Deployment Complete!"
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
log_info "  API Endpoint: $API_ENDPOINT"
log_info "  Dashboard URL: https://main.d1uumqiqpqm7bm.amplifyapp.com/dashboard/quickbets"
log_info "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
