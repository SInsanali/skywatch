#!/bin/bash
# Start Skywatch in the background. Logs to skywatch.log, PID in .skywatch.pid.
set -e
cd "$(dirname "$0")"

if [ -f .skywatch.pid ]; then
    OLD_PID=$(cat .skywatch.pid)
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Skywatch is already running (PID $OLD_PID). Run ./stop.sh first."
        exit 1
    fi
    rm -f .skywatch.pid
fi

# Pick the first available python interpreter
if command -v python3 >/dev/null 2>&1; then
    PY=python3
elif command -v python >/dev/null 2>&1; then
    PY=python
else
    echo "No python3 or python found on PATH"
    exit 1
fi

nohup "$PY" skywatch.py > skywatch.log 2>&1 &
echo $! > .skywatch.pid
sleep 1

if kill -0 "$(cat .skywatch.pid)" 2>/dev/null; then
    echo "Skywatch started (PID $(cat .skywatch.pid))"
    echo "  URL:  http://localhost:8078"
    echo "  Logs: tail -f $(pwd)/skywatch.log"
else
    echo "Skywatch failed to start. See skywatch.log:"
    tail -20 skywatch.log
    rm -f .skywatch.pid
    exit 1
fi
