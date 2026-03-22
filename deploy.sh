#!/bin/bash
set -e

SERVER="hp-alma9"
REMOTE_USER="skywatch"
REMOTE_DIR="/home/skywatch/skywatch"
STAGING_DIR="/tmp/skywatch-deploy"

run_as_skywatch() {
    ssh ${SERVER} "sudo -u ${REMOTE_USER} bash -c '$1'"
}

echo "=== Skywatch Deploy ==="

echo "Syncing files..."
rsync -avz --exclude '.git' --exclude '__pycache__' --exclude '.venv' \
    --exclude '*.plan' --exclude '.claude' --exclude '.DS_Store' \
    --exclude '*credentials*.json' --exclude 'node_modules' \
    . ${SERVER}:${STAGING_DIR}/
ssh ${SERVER} "sudo rsync -a --delete ${STAGING_DIR}/ ${REMOTE_DIR}/ && sudo chown -R ${REMOTE_USER}:${REMOTE_USER} ${REMOTE_DIR} && rm -rf ${STAGING_DIR}"

echo "Deploying with Docker Compose..."
run_as_skywatch "cd ${REMOTE_DIR} && docker compose up -d --build"

echo ""
echo "=== Deploy Complete ==="
run_as_skywatch "cd ${REMOTE_DIR} && docker compose ps"
echo ""
echo "Open http://192.168.68.190:8078"
