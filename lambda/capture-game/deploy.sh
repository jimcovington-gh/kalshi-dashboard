#!/bin/bash
set -e

echo "========================================="
echo "Capture Game API Deployment"
echo "========================================="

# Check Python syntax before deploying
echo ""
echo "Step 1: Checking Python syntax..."
python3 -m py_compile capture-game-api.py
python3 -m py_compile capture-queue-checker.py
echo "✅ Python syntax check passed"

# Build and deploy with SAM
echo ""
echo "Step 2: Building SAM application..."
sam build

echo ""
echo "Step 3: Deploying to AWS..."
sam deploy --no-confirm-changeset --no-fail-on-empty-changeset

echo ""
echo "========================================="
echo "Deployment complete!"
echo ""
echo "API Endpoint: Check CloudFormation outputs"
echo "========================================="
