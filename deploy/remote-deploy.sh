#!/usr/bin/env bash
# Runs ON the EC2 instance (as root, sent by GitHub Actions through SSM Run Command).
# Usage: IMAGE=<registry>/<repo>:<tag> bash remote-deploy.sh
set -euo pipefail

: "${IMAGE:?IMAGE must be set, e.g. 1234.dkr.ecr.us-east-1.amazonaws.com/repo:sha-abc1234}"
REGION="${AWS_REGION:-us-east-1}"
REGISTRY="${IMAGE%%/*}"
CONTAINER=nova-chat
VOLUME=nova-chat-data
DATA_DIR="/var/lib/docker/volumes/$VOLUME/_data"
BACKUP_DIR=/home/ec2-user/backups
KEEP_BACKUPS=10

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

start_container() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" --restart unless-stopped \
    -p 80:8000 \
    -v "$VOLUME":/app/data \
    "$1" >/dev/null
}

wait_healthy() {
  local status=""
  for _ in $(seq 1 45); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)
    [ "$status" = healthy ] && return 0
    [ "$status" = unhealthy ] && break
    sleep 2
  done
  log "container status: $status"
  docker logs --tail 30 "$CONTAINER" 2>&1 || true
  return 1
}

# 1. Back up the database (keep the newest $KEEP_BACKUPS)
docker volume create "$VOLUME" >/dev/null
if [ -f "$DATA_DIR/chat.db" ]; then
  mkdir -p "$BACKUP_DIR"
  backup="$BACKUP_DIR/chat.db.$(date -u +%Y%m%d-%H%M%S)"
  cp "$DATA_DIR/chat.db" "$backup"
  log "database backed up to $backup"
  ls -1t "$BACKUP_DIR"/chat.db.* | tail -n +$((KEEP_BACKUPS + 1)) | xargs -r rm -f
fi

# 2. Pull the new image (the instance role has ECR read access)
log "pulling $IMAGE"
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null 2>&1
docker pull -q "$IMAGE"

# 3. Swap containers, roll back if the new one isn't healthy
previous=$(docker inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)
log "previous image: ${previous:-none}"

start_container "$IMAGE"
if wait_healthy; then
  log "new version is healthy: $IMAGE"
else
  log "new version FAILED health check"
  if [ -n "$previous" ] && [ "$previous" != "$IMAGE" ]; then
    log "rolling back to $previous"
    start_container "$previous"
    wait_healthy && log "rollback healthy" || log "rollback ALSO unhealthy, check the instance"
  fi
  exit 1
fi

# 4. Free disk space: remove unused images older than a week (the running one is kept)
docker image prune -af --filter "until=168h" >/dev/null 2>&1 || true
docker ps --filter "name=$CONTAINER" --format '{{.Names}} | {{.Image}} | {{.Status}}'
