#!/bin/bash
set -e

SERVER="hp-alma9"
REMOTE_USER="skywatch"
REMOTE_DIR="/home/skywatch/skywatch"
STAGING_DIR="/tmp/skywatch-deploy"
QUADLET_DIR="/home/skywatch/.config/containers/systemd"
IMAGE_NAME="skywatch"

run_as_skywatch() {
    ssh ${SERVER} "sudo -u ${REMOTE_USER} bash -c 'export XDG_RUNTIME_DIR=/run/user/\$(id -u) && $1'"
}

echo "=== Skywatch Deploy ==="

echo "Syncing files..."
rsync -avz --exclude '.git' --exclude '__pycache__' --exclude '.venv' \
    --exclude '*.plan' --exclude '.claude' --exclude '.DS_Store' \
    --exclude '*credentials*.json' \
    . ${SERVER}:${STAGING_DIR}/
ssh ${SERVER} "sudo rsync -a --delete ${STAGING_DIR}/ ${REMOTE_DIR}/ && sudo chown -R ${REMOTE_USER}:${REMOTE_USER} ${REMOTE_DIR} && rm -rf ${STAGING_DIR}"

echo "Building container..."
run_as_skywatch "cd ${REMOTE_DIR} && podman build -t ${IMAGE_NAME}:latest ."

echo "Installing Quadlet unit..."
run_as_skywatch "cp ${REMOTE_DIR}/skywatch.container ${QUADLET_DIR}/"
run_as_skywatch "systemctl --user daemon-reload"

echo "Restarting service..."
run_as_skywatch "systemctl --user restart skywatch"

echo ""
echo "=== Deploy Complete ==="
run_as_skywatch "systemctl --user status skywatch --no-pager" || true
echo ""
echo "Open http://192.168.68.190:8078"
