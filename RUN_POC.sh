#!/bin/bash

# Financial Forecasting POC Startup Script

echo "================================"
echo "🚀 Financial Forecasting POC"
echo "================================"
echo ""

# Check Python
echo "Checking Python..."
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 not found. Please install Python 3.11+"
    exit 1
fi
if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))'; then
    echo "❌ Python 3.11+ is required. See financial_forecasting/DEV_SETUP_GUIDE.md."
    exit 1
fi
echo "✅ Python found: $(python3 --version)"

# Check required Python packages
echo ""
echo "Checking Python packages..."
python3 -c "import fastapi" 2>/dev/null || { echo "❌ Follow financial_forecasting/DEV_SETUP_GUIDE.md to bootstrap patched pip and install dependencies."; exit 1; }
echo "✅ FastAPI installed"

# Test Salesforce connection
echo ""
echo "Testing Salesforce connection..."
cd /Users/jacquelinereverand/pursuit-mcp-client
python3 test_simple_auth.py > /dev/null 2>&1 || { echo "⚠️  Salesforce connection test failed. Check credentials in financial_forecasting/config.py"; }

echo ""
echo "================================"
echo "✅ All checks passed!"
echo "================================"
echo ""
echo "To start the POC:"
echo ""
echo "1️⃣  Start Backend (in this terminal):"
echo "   cd /Users/jacquelinereverand/pursuit-mcp-client/financial_forecasting"
echo "   python3 main.py"
echo ""
echo "2️⃣  Start Frontend (in a NEW terminal):"
echo "   cd /Users/jacquelinereverand/pursuit-mcp-client/financial_forecasting/frontend"
echo "   npm install  # (first time only)"
echo "   npm start"
echo ""
echo "3️⃣  Open browser to: http://localhost:3000"
echo ""
echo "================================"
echo ""
