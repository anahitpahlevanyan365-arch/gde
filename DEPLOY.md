# Deploying Nova Chat to EC2 with Docker

## How AWS credentials work

The app uses boto3's **default credential chain**, so the code is the same everywhere. Only the credential source changes:

| Where it runs        | Credentials come from                                    |
|----------------------|----------------------------------------------------------|
| Your laptop (venv)   | `~/.aws/credentials` (from `aws configure`)              |
| Local Docker         | `~/.aws` mounted read-only into the container            |
| **EC2**              | **IAM role attached to the instance** (no keys at all)   |

**Do not copy your access keys to EC2** or bake them into the image. An IAM role gives the instance temporary credentials that rotate automatically, and boto3 picks them up by itself.

---

## Run locally

```powershell
docker build -t nova-chat:latest .
docker volume create nova-chat-data
docker run -d --name nova-chat --restart unless-stopped -p 8002:8000 `
  -v "$env:USERPROFILE\.aws:/home/appuser/.aws:ro" `
  -v nova-chat-data:/app/data `
  nova-chat:latest
```

Open http://localhost:8002

---

## Deploy to EC2

### 1. Create an IAM role for the instance

1. In the IAM console, go to **Roles → Create role → AWS service → EC2**.
2. Add an inline policy using [iam-bedrock-policy.json](iam-bedrock-policy.json). It allows calling only the Claude model this app uses.
3. Also attach the AWS managed policy **AmazonEC2ContainerRegistryReadOnly** so the instance can pull the image from ECR.
4. Name it, for example `nova-chat-ec2-role`.

> Bedrock model access for Claude must already be enabled in the account (it is, if `test_bedrock.py` works for you).

### 2. Push the image to ECR (from your machine)

Repository: `881490130721.dkr.ecr.us-east-1.amazonaws.com/gde-anahit-nova-chat` (already created; `v1`, `v2`, `v3` and `latest` pushed. `v2` adds login, the free limit and the context window; `v3` adds the robot mascot. Next release: `v4`).

Run these in **Git Bash**. Windows PowerShell 5.1 corrupts the password when piping it into `docker login`, and ECR then answers `400 Bad Request`.

```bash
REGISTRY=881490130721.dkr.ecr.us-east-1.amazonaws.com
REPO=$REGISTRY/gde-anahit-nova-chat

aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin $REGISTRY

# Bump the version for each release (v2, v3, ...) and also move "latest"
docker build -t nova-chat:latest .
docker tag nova-chat:latest $REPO:v2
docker tag nova-chat:latest $REPO:latest
docker push $REPO:v2
docker push $REPO:latest
```

> The image is built for **x86_64 (amd64)**. Use an x86 instance type (for example `t3.small`). For a Graviton instance (`t4g.*`), build with `docker buildx build --platform linux/arm64 ...`.

### 3. Launch the EC2 instance

- **AMI:** Amazon Linux 2023
- **Instance type:** `t3.small` (or `t3.micro` for light use)
- **IAM instance profile:** `nova-chat-ec2-role` (under *Advanced details*)
- **Metadata:** IMDSv2 *required*, **hop limit = 2**. A container is one network hop further than the host, so with hop limit 1 boto3 inside Docker cannot reach the role credentials. To fix an existing instance:
  ```bash
  aws ec2 modify-instance-metadata-options --instance-id <ID> --http-tokens required --http-put-response-hop-limit 2
  ```
- **Security group:** allow inbound TCP **80** from **your IP only** (see the security note below), and SSH 22 from your IP. Or use SSM Session Manager and skip SSH.

### 4. Install Docker and run the container (on the instance)

```bash
sudo dnf install -y docker
sudo systemctl enable --now docker

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGION=us-east-1
REPO=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/gde-anahit-nova-chat

aws ecr get-login-password --region $REGION | sudo docker login --username AWS --password-stdin $ACCOUNT.dkr.ecr.$REGION.amazonaws.com
sudo docker pull $REPO:latest

sudo docker volume create nova-chat-data
sudo docker run -d --name nova-chat --restart unless-stopped \
  -p 80:8000 \
  -v nova-chat-data:/app/data \
  $REPO:latest
```

Note: no `~/.aws` mount and no keys. The role does the work.

Open `http://<EC2-public-IP>/`

### 5. Verify credentials inside the container

```bash
sudo docker exec nova-chat python -c "import boto3; print(boto3.client('sts').get_caller_identity()['Arn'])"
```

You should see an ARN like `arn:aws:sts::<account>:assumed-role/nova-chat-ec2-role/i-...`.

### Updating to a new version

```bash
sudo docker pull $REPO:latest
sudo docker rm -f nova-chat
sudo docker run -d --name nova-chat --restart unless-stopped -p 80:8000 -v nova-chat-data:/app/data $REPO:latest
```

Chat history lives in the `nova-chat-data` volume, so it survives updates.

---

## Configuration (environment variables)

| Variable           | Default                                 |
|--------------------|-----------------------------------------|
| `AWS_REGION`       | `us-east-1`                             |
| `BEDROCK_MODEL_ID` | `global.anthropic.claude-opus-4-6-v1`   |
| `DATA_DIR`         | `/app/data` (SQLite file `chat.db`)     |
| `SECRET_KEY`       | Random key, generated once and saved as `secret_key` in `DATA_DIR` |
| `SESSION_COOKIE_SECURE` | off. Set to `1` once the site is served over HTTPS |
| `FREE_MESSAGE_LIMIT` | `10` messages per account |
| `CONTEXT_MAX_TOKENS` | `8000`. Estimated tokens of chat history sent to the model per request (newest messages first) |
| `MESSAGE_MAX_CHARS` | `10000` characters per message |

Override with `-e BEDROCK_MODEL_ID=...` on `docker run`. If you change the model, update the IAM policy too.

---

## Security note

Users must register and log in, and each user only sees their own chats. The first account registered takes over any chats saved before login was added.

Each account gets `FREE_MESSAGE_LIMIT` (10) free messages. Registration is still **open**, though, so someone could create many accounts and chat on your AWS bill. So keep the security group restricted to your own IP. Also, without HTTPS, passwords and session cookies are sent in plain text. Add HTTPS (for example an ALB with an ACM certificate) and set `SESSION_COOKIE_SECURE=1` before sharing it more widely.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `AWS credentials not found` on EC2 | No instance role attached, or metadata hop limit is 1 |
| `AccessDeniedException` | Role policy is missing `bedrock:InvokeModelWithResponseStream`, or the model ID changed |
| `docker pull` denied | Role is missing `AmazonEC2ContainerRegistryReadOnly`, or the ECR login expired (re-run login) |
| Chats lost after update | Container started without `-v nova-chat-data:/app/data` |
