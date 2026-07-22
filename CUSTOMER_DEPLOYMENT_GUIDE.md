# Claude Apps Gateway — Deployment Guide

## What you're deploying

A fully managed Claude Code gateway on your AWS account that:
- Authenticates developers via **corporate SSO** (Okta, Google Workspace, Entra, or any OIDC provider)
- Routes all inference to **Amazon Bedrock** (nothing leaves your AWS boundary)
- Provides an **admin console** for spend limits, model access, and audit logs
- Uses your **existing VPC** and VPN connectivity
- Deploys with a single `cdk deploy --all` command (~25-35 minutes)
- Uses **Aurora Serverless v2** (auto-pauses when idle, scales on demand)

**Cost:** ~$8-12/day infrastructure (Aurora auto-pauses at 0 ACU when idle) + Bedrock inference at standard pricing. No per-seat license.

---

## Architecture

Six CDK stacks deployed together:

| Stack | What it creates |
|-------|----------------|
| Network | Imports your existing VPC, creates security groups + VPC endpoints (Bedrock, Secrets Manager) |
| Database | Aurora Serverless v2 PostgreSQL (auto-pausing, encrypted at rest) |
| Secrets | Generated secrets for JWT signing, admin API key, and OIDC client secret |
| Build Machine | Temporary EC2 that builds container images (torn down automatically) |
| Gateway | The Claude gateway on ECS Express Mode (private, internal ALB) |
| Admin Console | Web UI for spend/model management (SSO-gated) |

---

## Prerequisites

### 1. AWS account

- [ ] AWS account with permissions to create: ECS, Aurora, IAM roles, Secrets Manager, EC2, VPC endpoints
- [ ] **Amazon Bedrock model access** enabled in the target region for Claude models

  Verify it works:
  ```bash
  aws bedrock-runtime converse \
    --model-id global.anthropic.claude-sonnet-5 \
    --messages '[{"role":"user","content":[{"text":"ping"}]}]' \
    --inference-config '{"maxTokens":5}' \
    --region <your-region>
  ```

- [ ] **Existing VPC** with:
  - At least 2 private subnets (with NAT gateway for outbound internet)
  - VPN or Direct Connect for developer access to the private subnets
- [ ] **AWS CLI** configured with credentials for the target account
- [ ] **Node.js 20+** installed
- [ ] **AWS CDK CLI** installed: `npm install -g aws-cdk`
- [ ] **Docker** running locally

### 2. Identity Provider (OIDC)

Any OIDC-compliant provider works. Create an OAuth application:

#### Okta
- Create a **Web Application** in Okta admin
- Redirect URI: `https://placeholder.invalid/oauth/callback` (update after deploy)
- Note: Client ID, Client Secret, Issuer URL (e.g., `https://your-org.okta.com/oauth2/default`)
- Create an admin group (e.g., `PlatformEngineering`) and add admin users
- Configure `groups` claim on your authorization server

#### Google Workspace
- Create an **OAuth 2.0 Web Application** in Google Cloud Console
- OAuth consent screen: Internal
- Redirect URI: `https://placeholder.invalid/oauth/callback` (update after deploy)
- Note: Client ID, Client Secret
- Issuer is always: `https://accounts.google.com`

#### Microsoft Entra ID
- Register a **Web** app (single tenant)
- Redirect URI: `https://placeholder.invalid/oauth/callback` (update after deploy)
- Note: Client ID, Client Secret, Issuer URL (`https://login.microsoftonline.com/<tenant>/v2.0`)
- Enable `groups` claim in Token configuration

### 3. Developer machines (post-deploy)

- [ ] Claude Code **v2.1.195 or later** (recommend v2.1.199+)
- [ ] A way to push a config file to developer machines (MDM, Jamf, Intune, or manual)

---

## Values to collect before deploying

| Parameter | Context key | Example |
|-----------|-------------|---------|
| VPC ID | `vpcId` | `vpc-0abc123def456` |
| Private subnet IDs (comma-separated) | `privateSubnetIds` | `subnet-aaa,subnet-bbb` |
| Private subnet AZs (comma-separated) | `privateSubnetAzs` | `us-east-1a,us-east-1b` |
| VPC CIDR | `vpcCidr` | `10.0.0.0/16` |
| OIDC issuer URL | `oidcIssuer` | `https://your-org.okta.com/oauth2/default` |
| OIDC client ID | `oidcClientId` | `0oaXXXXXXXXXXX` |
| OIDC client secret | `oidcClientSecret` | (from your IdP) |
| Admin group name | `adminOktaGroupName` | `PlatformEngineering` |

---

## Deploy

### Step 1 — Clone and install

```bash
git clone <this-repo-url>
cd sample-claude-apps-gateway-on-aws/cdk
npm install
```

### Step 2 — Bootstrap CDK (first time only)

```bash
CDK_DEFAULT_ACCOUNT=<your-account-id> CDK_DEFAULT_REGION=<your-region> \
npx cdk bootstrap aws://<your-account-id>/<your-region> \
  -c oidcIssuer=<issuer> -c oidcClientId=<client-id> -c oidcClientSecret=<secret>
```

### Step 3 — Configure gateway.yaml (if needed)

The default `gateway/gateway.yaml` works for most setups. Adjust if needed:

**For Google Workspace** — edit the `oidc` section:
```yaml
  scopes: [openid, profile, email]
  extra_auth_params:
    access_type: offline
    prompt: consent
```

**For non-US regions** — ensure models use `global.anthropic.*` profiles (already configured).

**For US regions** — you can switch to `auto_include_builtin_models: true` and remove the explicit `models:` block.

### Step 4 — Deploy all stacks

```bash
CDK_DEFAULT_ACCOUNT=<your-account-id> CDK_DEFAULT_REGION=<your-region> \
npx cdk deploy --all --require-approval never \
  -c vpcId=<your-vpc-id> \
  -c privateSubnetIds=<subnet-1>,<subnet-2> \
  -c privateSubnetAzs=<az-1>,<az-2> \
  -c vpcCidr=<your-vpc-cidr> \
  -c oidcIssuer=<your-issuer-url> \
  -c oidcClientId=<your-client-id> \
  -c oidcClientSecret="<your-client-secret>" \
  -c adminOktaGroupName=<your-admin-group>
```

This takes **25-35 minutes**. When complete, note the two URLs in the output:
```
ClaudeGatewayStack.GatewayEndpoint = https://cl-xxxx.ecs.<region>.on.aws
ClaudeGatewayAdminConsoleStack.AdminConsoleEndpoint = https://cl-yyyy.ecs.<region>.on.aws
```

### Step 5 — Update your IdP redirect URI

Go back to your identity provider and replace the placeholder redirect URI with:
```
https://<your-gateway-endpoint>/oauth/callback
```

### Step 6 — Verify

With VPN connected:

```bash
# Gateway health check
curl -s https://<gateway-endpoint>/healthz

# Admin console — open in browser
open https://<admin-console-endpoint>/signin
```

Sign in with your corporate identity. You should land on the spend dashboard.

---

## Wire developer machines

Push this JSON file to each developer's machine:

```json
{
  "forceLoginMethod": "gateway",
  "forceLoginGatewayUrl": "https://<your-gateway-endpoint>"
}
```

| Platform | File path | How to deploy |
|----------|-----------|---------------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` | Jamf, manual (`sudo`) |
| Linux / WSL | `/etc/claude-code/managed-settings.json` | Ansible, Chef, manual |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` | Intune, Group Policy |

Then each developer runs:
```bash
claude /login
```
→ Browser opens → SSO → done.

---

## Admin console features

Access at `https://<admin-console-endpoint>` (requires VPN + SSO with admin group membership):

| Feature | What it does |
|---------|-------------|
| **Spend Dashboard** | Real-time per-user cost breakdown |
| **Spend Limits** | Set daily/weekly/monthly caps per user or org-wide |
| **Model Access** | Enable/disable Claude models (live from Bedrock catalog, no redeploy) |
| **Audit Log** | Every admin action traced to the real user who made it |

---

## Day-2 operations

| Task | How |
|------|-----|
| Add/remove developers | Add/remove from IdP. Session expires within `ttl_hours`. |
| Change model access | Admin console → Models → toggle checkboxes |
| Set spend limits | Admin console → Limits → create/edit/delete |
| Offboard a user | Remove from IdP. No credential rotation needed. |
| Change gateway config (YAML) | Edit `gateway/gateway.yaml` → rebuild image → push to ECR → redeploy |
| Change env vars only | Update ECS task env var → force new deployment (no rebuild) |
| Upgrade Claude version | Update `CLAUDE_CODE_VERSION` in `gateway/Dockerfile` → rebuild → push → redeploy |
| Tear down everything | `npx cdk destroy --all` |

### Rebuilding the gateway image

```bash
cd gateway
docker build --platform linux/amd64 -t <ECR_URI>:latest .
docker push <ECR_URI>:latest
aws ecs update-express-gateway-service \
  --service-arn <gateway-service-arn> \
  --health-check-path /healthz
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `redirect_uri_mismatch` at IdP sign-in | Redirect URI not updated in IdP | Set it to `https://<gateway-endpoint>/oauth/callback` exactly |
| "not a member of group" after sign-in | Groups claim not in token | Configure `groups` claim on your IdP's authorization server/token config |
| Admin console hangs at sign-in | VPN not connected | Connect VPN first |
| `claude /login` hangs | VPN not connected or managed-settings.json not in system-level path | Check VPN + file path |
| 400 upstream rejected | Model not available in region, or IAM policy missing `global.anthropic.*` | Verify Bedrock model access + task role IAM |
| Build machine "Instance never registered with SSM" | Subnets lack NAT gateway or outbound internet | Ensure private subnets route to a NAT gateway |
| Aurora version not found | PG version unavailable in region | Check `aws rds describe-db-engine-versions --engine aurora-postgresql` |
| Gateway crash-loops | OIDC client secret wrong/missing | Check Secrets Manager value |

---

## Security posture

- **No credentials on developer machines** — only the gateway URL
- **Private gateway** — internal ALB, reachable only via VPN
- **All inference stays in your AWS account** — Bedrock, no data to third parties
- **SSO-gated everything** — authentication + admin access via IdP group membership
- **Container image verified** — Claude binary GPG-signed + SHA256-checked at build time
- **Aurora encrypted at rest** — managed credentials, auto-rotating
- **Every admin action audited** — traced to real identity, not a shared key

---

## Cleanup

```bash
cd cdk
CDK_DEFAULT_ACCOUNT=<account> CDK_DEFAULT_REGION=<region> \
npx cdk destroy --all \
  -c vpcId=<vpc-id> \
  -c privateSubnetIds=<subnets> \
  -c privateSubnetAzs=<azs> \
  -c vpcCidr=<cidr> \
  -c oidcIssuer=<issuer> \
  -c oidcClientId=<client-id> \
  -c oidcClientSecret=<secret> \
  -c adminOktaGroupName=<group>
```

This removes ALL deployed resources. Aurora data is not recoverable after destruction.
