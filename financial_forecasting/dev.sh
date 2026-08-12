#!/bin/bash
# Start both backend and frontend, survive terminal/session closes.
# Run this from your own terminal (not via Claude Code) so processes persist.
# Usage: ./dev.sh [stop]

BACKEND_DIR="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$BACKEND_DIR/frontend-v2"
BACKEND_LOG="/tmp/bedrock-backend.log"
FRONTEND_LOG="/tmp/bedrock-frontend.log"
BACKEND_PID_FILE="/tmp/bedrock-backend.pid"
FRONTEND_PID_FILE="/tmp/bedrock-frontend.pid"

# Always prefer the project venv. Bare `python3` resolves to system Python
# (3.9 on macOS), which has none of requirements.txt and can't even import
# main.py — the failure reads as "No module named 'dotenv'" in the log, with
# nothing on stdout to say the venv was skipped. Checking here means the script
# works whether or not the venv is activated in the calling shell.
if [ -x "$BACKEND_DIR/.venv/bin/python" ]; then
  PY="$BACKEND_DIR/.venv/bin/python"
elif [ -x "$BACKEND_DIR/venv/bin/python" ]; then
  PY="$BACKEND_DIR/venv/bin/python"
else
  PY="$(command -v python3)"
fi

stop() {
  if [ -f "$BACKEND_PID_FILE" ]; then
    kill "$(cat "$BACKEND_PID_FILE")" 2>/dev/null && echo "Backend stopped"
    rm "$BACKEND_PID_FILE"
  fi
  if [ -f "$FRONTEND_PID_FILE" ]; then
    kill "$(cat "$FRONTEND_PID_FILE")" 2>/dev/null && echo "Frontend stopped"
    rm "$FRONTEND_PID_FILE"
  fi
}

if [ "$1" = "stop" ]; then
  stop
  exit 0
fi

# Stop any existing instances
stop

# Fail loudly and immediately rather than backgrounding a process that dies on
# its first import — the whole point of the log is to show a running server.
if ! "$PY" -c "import dotenv, fastapi, asyncpg, uvicorn" 2>/dev/null; then
  echo "ERROR: $PY can't import the backend's dependencies."
  echo "  $("$PY" --version 2>&1)"
  echo ""
  echo "Create the venv and install them:"
  echo "  python3.13 -m venv $BACKEND_DIR/.venv"
  echo "  $BACKEND_DIR/.venv/bin/pip install -r $BACKEND_DIR/requirements.txt"
  exit 1
fi

if [ ! -f "$BACKEND_DIR/.env" ]; then
  echo "ERROR: $BACKEND_DIR/.env is missing — ask Jac for yours (never commit it)."
  exit 1
fi

echo "Starting backend on :8000 ($("$PY" --version 2>&1)) ..."
cd "$BACKEND_DIR"
nohup "$PY" main.py > "$BACKEND_LOG" 2>&1 &
echo $! > "$BACKEND_PID_FILE"

echo "Starting frontend on :4200 ..."
cd "$FRONTEND_DIR"
nohup npm run dev -- --host 0.0.0.0 --port 4200 > "$FRONTEND_LOG" 2>&1 &
echo $! > "$FRONTEND_PID_FILE"

echo ""
echo "Backend:  http://localhost:8000  (logs: tail -f $BACKEND_LOG)"
echo "Frontend: http://localhost:4200  (logs: tail -f $FRONTEND_LOG)"
echo ""
echo "Stop with: ./dev.sh stop"
