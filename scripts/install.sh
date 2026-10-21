#!/bin/bash
# Installation script for pursuit-mcp-client

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

echo "🚀 Installing Pursuit MCP Client..."

# Create virtual environment if it doesn't exist
if [ ! -d "venv" ]; then
    if ! python3 -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
        echo "❌ Python 3.10+ is required for the MCP client (backend and Pebble require 3.11+)."
        exit 1
    fi
    echo "📦 Creating virtual environment..."
    python3 -m venv venv
fi

venv_python="$repo_root/venv/bin/python"
if ! "$venv_python" -c 'import sys; sys.exit(sys.version_info < (3, 10))'; then
    echo "❌ Existing venv requires Python 3.10+. Recreate it with a supported interpreter."
    exit 1
fi

# Bootstrap the patched trust store with the Python security team's pinned hash.
echo "⬆️  Installing patched pip trust store..."
bash "$repo_root/scripts/bootstrap-pip.sh" "$venv_python"

# Install dependencies
echo "📥 Installing dependencies..."
"$venv_python" -m pip install -r requirements.txt

# Install in development mode
echo "🔗 Installing package in development mode..."
"$venv_python" -m pip install -e .

echo "✅ Installation completed!"
echo ""
echo "🎯 Next steps:"
echo "1. Copy .env.example to .env and fill in your credentials"
echo "2. Run 'source venv/bin/activate' to activate the environment"
echo "3. Run 'python examples/basic_usage.py' to test the client"
echo "4. Or run 'mcp-client --demo all' to test all services"
