#!/bin/bash
# Dashboard Deploy Script
# Builds locally to catch TypeScript errors, then pushes to trigger Amplify deployment
#
# Usage: ./deploy.sh "commit message"

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_ID="d1uumqiqpqm7bm"
BRANCH="main"

# Get commit message
COMMIT_MSG="${1:-Dashboard update}"

echo "========================================="
echo "Dashboard Deploy Script"
echo "========================================="
echo ""

# Step 1: Check for changes
echo "Step 1: Checking for changes..."
if git diff --quiet && git diff --staged --quiet; then
    echo -e "${YELLOW}No changes to deploy${NC}"
    exit 0
fi
git status --short
echo ""

# Step 2: Run local build to catch TypeScript errors
echo "Step 2: Running local build (TypeScript check)..."
if ! npm run build > /tmp/dashboard-build.log 2>&1; then
    echo -e "${RED}❌ Build failed! Fix errors before deploying:${NC}"
    echo ""
    # Extract and show the error
    grep -A 10 "Type error\|Error:" /tmp/dashboard-build.log | head -20
    echo ""
    echo "Full log: /tmp/dashboard-build.log"
    exit 1
fi
echo -e "${GREEN}✅ Local build passed${NC}"
echo ""

# Step 3: Commit and push
echo "Step 3: Committing and pushing..."
git add -A
git commit -m "$COMMIT_MSG"
git push origin main
COMMIT_HASH=$(git rev-parse HEAD)
echo -e "${GREEN}✅ Pushed commit: ${COMMIT_HASH:0:7}${NC}"
echo ""

# Step 4: Wait for Amplify to pick up the build
echo "Step 4: Waiting for Amplify build to start..."
sleep 5

# Get the latest job (head -1 to strip NextToken line)
JOB_ID=$(aws amplify list-jobs --app-id "$APP_ID" --branch-name "$BRANCH" --max-items 1 --query 'jobSummaries[0].jobId' --output text | head -1)

if [ -z "$JOB_ID" ] || [ "$JOB_ID" == "None" ]; then
    echo -e "${YELLOW}Could not find Amplify job. Check manually.${NC}"
    exit 0
fi

echo "Amplify Job ID: $JOB_ID"
echo ""

# Step 5: Poll for completion
echo "Step 5: Waiting for Amplify build to complete..."
MAX_WAIT=300  # 5 minutes
WAITED=0
POLL_INTERVAL=10

while [ $WAITED -lt $MAX_WAIT ]; do
    # head -1 strips the NextToken line from output
    STATUS=$(aws amplify list-jobs --app-id "$APP_ID" --branch-name "$BRANCH" --max-items 1 --query 'jobSummaries[0].status' --output text 2>/dev/null | head -1 || echo "UNKNOWN")
    
    case "$STATUS" in
        SUCCEED)
            echo ""
            echo -e "${GREEN}=========================================${NC}"
            echo -e "${GREEN}✅ Deployment successful!${NC}"
            echo -e "${GREEN}=========================================${NC}"
            echo "URL: https://main.d1uumqiqpqm7bm.amplifyapp.com"
            exit 0
            ;;
        FAILED)
            echo ""
            echo -e "${RED}=========================================${NC}"
            echo -e "${RED}❌ Amplify build failed!${NC}"
            echo -e "${RED}=========================================${NC}"
            echo ""
            echo "Check logs in AWS Console or run:"
            echo "  aws amplify get-job --app-id $APP_ID --branch-name $BRANCH --job-id $JOB_ID"
            exit 1
            ;;
        CANCELLED)
            echo ""
            echo -e "${YELLOW}Build was cancelled${NC}"
            exit 1
            ;;
        *)
            printf "."
            sleep $POLL_INTERVAL
            WAITED=$((WAITED + POLL_INTERVAL))
            ;;
    esac
done

echo ""
echo -e "${YELLOW}Timed out waiting for build. Check status manually:${NC}"
echo "  aws amplify list-jobs --app-id $APP_ID --branch-name $BRANCH --max-items 1"
exit 1
