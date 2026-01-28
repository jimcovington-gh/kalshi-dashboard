#!/bin/bash
# Dashboard Deploy Script
# Deploys both Lambda API functions and Next.js frontend
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

# Step 2: Run pre-deploy validation
echo "Step 2: Running pre-deploy validation..."
if [ -f scripts/validate-before-deploy.sh ]; then
    if ! ./scripts/validate-before-deploy.sh; then
        echo -e "${RED}❌ Validation failed! Fix issues before deploying.${NC}"
        exit 1
    fi
else
    # Fallback to just build check if script doesn't exist
    echo "Running local build (TypeScript check)..."
    if ! npm run build > /tmp/dashboard-build.log 2>&1; then
        echo -e "${RED}❌ Build failed! Fix errors before deploying:${NC}"
        echo ""
        grep -A 10 "Type error\|Error:" /tmp/dashboard-build.log | head -20
        echo ""
        echo "Full log: /tmp/dashboard-build.log"
        exit 1
    fi
fi
echo -e "${GREEN}✅ Validation passed${NC}"
echo ""

# Step 2.5: Check Python syntax before SAM deploy
echo "Step 2.5: Checking Python syntax..."
SYNTAX_ERROR=0
for pyfile in "$SCRIPT_DIR/lambda"/*.py; do
    if ! python3 -m py_compile "$pyfile" 2>/tmp/syntax-error.log; then
        echo -e "${RED}❌ Syntax error in $(basename $pyfile):${NC}"
        cat /tmp/syntax-error.log
        SYNTAX_ERROR=1
    fi
done
if [ $SYNTAX_ERROR -eq 1 ]; then
    echo -e "${RED}Fix Python syntax errors before deploying${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Python syntax OK${NC}"
echo ""

# Step 3: Deploy Lambda functions (SAM)
echo "Step 3: Deploying Lambda API functions..."
cd "$SCRIPT_DIR/lambda"

echo "Building Lambda functions..."
if ! sam build > /tmp/sam-build.log 2>&1; then
    echo -e "${RED}❌ SAM build failed!${NC}"
    cat /tmp/sam-build.log | tail -20
    exit 1
fi
echo -e "${GREEN}✅ SAM build passed${NC}"

echo "Deploying Lambda functions..."
# Capture both stdout and stderr, and the exit code
set +e  # Temporarily allow errors
sam deploy > /tmp/sam-deploy.log 2>&1
SAM_EXIT_CODE=$?
set -e  # Re-enable exit on error

if [ $SAM_EXIT_CODE -ne 0 ]; then
    # Check if this is just "no changes" (which SAM incorrectly returns as exit code 1)
    if grep -q "No changes to deploy" /tmp/sam-deploy.log; then
        echo -e "${YELLOW}⚠️  No Lambda changes to deploy (stack is up to date)${NC}"
    else
        echo -e "${RED}❌ SAM deploy failed!${NC}"
        cat /tmp/sam-deploy.log | tail -30
        exit 1
    fi
else
    echo -e "${GREEN}✅ Lambda functions deployed${NC}"
fi

cd "$SCRIPT_DIR"
echo ""

# Step 4: Commit and push (triggers Amplify for frontend)
echo "Step 4: Committing and pushing..."
git add -A
git commit -m "$COMMIT_MSG"
git push origin main
COMMIT_HASH=$(git rev-parse HEAD)
echo -e "${GREEN}✅ Pushed commit: ${COMMIT_HASH:0:7}${NC}"
echo ""

# Step 5: Wait for Amplify to pick up the build
echo "Step 5: Waiting for Amplify build to start..."
sleep 5

# Get the latest job (head -1 to strip NextToken line)
JOB_ID=$(aws amplify list-jobs --app-id "$APP_ID" --branch-name "$BRANCH" --max-items 1 --query 'jobSummaries[0].jobId' --output text | head -1)

if [ -z "$JOB_ID" ] || [ "$JOB_ID" == "None" ]; then
    echo -e "${YELLOW}Could not find Amplify job. Check manually.${NC}"
    exit 0
fi

echo "Amplify Job ID: $JOB_ID"
echo ""

# Step 6: Poll for completion
echo "Step 6: Waiting for Amplify build to complete..."
MAX_WAIT=480  # 8 minutes (Amplify builds typically take 3-5 min)
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
            echo "Frontend: https://main.d1uumqiqpqm7bm.amplifyapp.com"
            echo "API: https://cmpdhpkk5d.execute-api.us-east-1.amazonaws.com/prod"
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
