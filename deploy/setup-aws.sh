#!/usr/bin/env bash
# One-time AWS setup for the GitHub Actions deploy. Safe to re-run.
# Run from Git Bash in this folder:  bash deploy/setup-aws.sh
set -euo pipefail
cd "$(dirname "$0")"

ROLE=gde-anahit-github-deploy
INSTANCE_ROLE=gde-anahit-ec2-role

# 1. Role that GitHub Actions assumes (only from anahitpahlevanyan365-arch/gde, branch main)
if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE" --policy-document file://github-trust-policy.json
  echo "updated trust policy of $ROLE"
else
  aws iam create-role --role-name "$ROLE" \
    --description "GitHub Actions (anahitpahlevanyan365-arch/gde, main) deploys Nova Chat" \
    --assume-role-policy-document file://github-trust-policy.json >/dev/null
  echo "created role $ROLE"
fi

# 2. What it may do: push to the ECR repo and run commands on the one instance
aws iam put-role-policy --role-name "$ROLE" --policy-name nova-chat-deploy \
  --policy-document file://github-deploy-policy.json
echo "attached deploy permissions to $ROLE"

# 3. Let the EC2 instance receive SSM Run Command (the SSM agent is preinstalled on Amazon Linux 2023)
aws iam attach-role-policy --role-name "$INSTANCE_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
echo "attached AmazonSSMManagedInstanceCore to $INSTANCE_ROLE"

echo
echo "Done. The instance shows up in SSM within a few minutes."
echo "To speed that up, restart its agent:  sudo systemctl restart amazon-ssm-agent"
