#!/bin/bash
# Stop the running Skywatch instance.
cd "$(dirname "$0")"

if [ -f .skywatch.pid ]; then
    PID=$(cat .skywatch.pid)
    if kill -0 "$PID" 2>/dev/null; then
        kill "$PID"
        # Wait up to 5s for graceful shutdown
        for i in 1 2 3 4 5; do
            if ! kill -0 "$PID" 2>/dev/null; then
                break
            fi
            sleep 1
        done
        if kill -0 "$PID" 2>/dev/null; then
            kill -9 "$PID" 2>/dev/null
            echo "Force-killed Skywatch (PID $PID)"
        else
            echo "Stopped Skywatch (PID $PID)"
        fi
    else
        echo "PID file present but process $PID is not running"
    fi
    rm -f .skywatch.pid
else
    # Fall back to pkill if PID file is gone
    if pkill -f "python3? skywatch.py" 2>/dev/null; then
        echo "Stopped Skywatch via pkill"
    else
        echo "Skywatch is not running"
    fi
fi
