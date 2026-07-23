# Claude Apps Gateway — Enterprise Deployment Guide (Google Workspace)

This guide walks your team through deploying the Claude Apps Gateway on AWS using **Google Workspace** as your identity provider. The gateway gives your developers Claude Code on Amazon Bedrock — without putting AWS credentials on any developer machine.

---

## What you're deploying

A fully managed Claude Code gateway on your AWS account that:

- Authenticates developers via **Google Workspace SSO** (your existing corporate Google accounts)
- Routes all Claude inference to **Amazon Bedrock** — nothing leaves your AWS boundary
- Provides an **admin console** for spend limits, model access control, and audit logs
- Deploys into your **existing VPC** using your existing VPN/Direct Connect connectivity
- Enforces **group-based model policies** (e.g., engineers get Sonnet, leads get Opus)
- Uses **Aurora Serverless v2** — auto-pauses when idle, scales on demand

**Estimated cost:** ~$8-12/day infrastructure when idle (Aurora auto-pauses at 0 ACU) + Bedrock inference at standard pricing. No per-seat license.

---

## Architecture

Six CDK stacks, deployed together in ~25-35 minutes:

| Stack | What it creates |
|-------|----------------|
| Network | Imports your existing VPC, creates security groups + VPC endpoints (Bedrock, Secrets Manager) |
| Database | Aurora Serverless v2 PostgreSQL (auto-pausing, encrypted at rest) |
| Secrets | Generated secrets for JWT signing, admin API key, and OIDC client secret |
| Build Machine | Temporary EC2 that builds container images (torn down automatically after build) |
| Gateway | The Claude gateway on ECS Express Mode (private, internal ALB) |
| Admin Console | Web UI for spend/model management on public subnets (SSO-gated) |

The gateway is **private** — reachable only via your VPN/Direct Connect. The admin console is **public** — gated by Google Workspace group membership, not network placement.

---

## Prerequisites

### 1. AWS account

- [ ] AWS account with permissions to create: ECS, Aurora, IAM roles, Secrets Manager, EC2, VPC endpoints, ECR
- [ ] **Amazon Bedrock model access** enabled for Claude models in the target region

  Verify with:
  ```bash
  aws bedrock-runtime converse \
    --model-id global.anthropic.claude-sonnet-5 \
    --messages '[{"role":"user","content":[{"text":"ping"}]}]' \
    --inference-config '{"maxTokens":5}' \
    --region <your-region>
  ```

- [ ] **Existing VPC** with:
  - At least 2 private subnets (with NAT Gateway for outbound internet access)
  - At least 2 public subnets (for the admin console ALB)
  - VPN or Direct Connect for developer access to the private subnets
- [ ] **AWS CLI** configured with credentials for the target account
- [ ] **Node.js 20+** installed
- [ ] **AWS CDK CLI** installed: `npm install -g aws-cdk`
- [ ] **Docker** running locally

### 2. Google Workspace setup

You need **one OAuth client** and **one or more Google Groups** before deploying.

#### 2.1 Create an OAuth 2.0 client

1. Go to [Google Cloud Console → APIs & Credentials](https://console.cloud.google.com/apis/credentials).
2. Select the project associated with your Google Workspace organization (or create one).
3. Go to **OAuth consent screen** (Google Auth Platform → Branding/Audience):
   - User type: **Internal** (restricts sign-in to your organization only)
   - Scopes: `openid`, `email`, `profile`
4. Go to **Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI: `https://placeholder.invalid/oauth/callback` (you'll update this after deploy)
5. Note the **Client ID** (e.g., `242196034593-xxxx.apps.googleusercontent.com`) and **Client Secret** (e.g., `GOCSPX-...`).

> **One client covers everything.** The same OAuth client is used by both the gateway (device-code flow for developers) and the admin console. No second app registration needed.

#### 2.2 Create admin group(s)

In [Google Admin Console → Groups](https://admin.google.com/ac/groups):

1. Create an admin group (e.g., `claude-gateway-admins@yourcompany.com`).
2. Add every user who should manage spend limits and model access.
3. (Optional) Create additional groups for tiered model access policies (e.g., `claude-engineers@yourcompany.com`, `claude-leads@yourcompany.com`).

> **How groups reach the gateway:** Google's ID token does not include a `groups` claim. The gateway uses `userinfo_fallback: true` to fetch profile data from Google's `/userinfo` endpoint. For group-based policies, the gateway's built-in `google_groups` feature can query the Google Admin SDK Directory API — see [Optional: Enable group-based policies](#optional-enable-group-based-policies) below.

#### 2.3 Key differences from Okta/Entra

| Item | Google Workspace | Notes |
|------|-----------------|-------|
| Issuer URL | `https://accounts.google.com` | Same for all orgs |
| Refresh tokens | `access_type: offline` + `prompt: consent` | Google ignores the standard `offline_access` scope |
| Group claims | Not in the ID token | Use `userinfo_fallback` + `google_groups` gateway config |
| Scopes | `[openid, email, profile]` | `groups` and `offline_access` are rejected |
| One OAuth client | Covers gateway + admin console | No separate app registration |

---

## Values to collect

Fill in before deploying:

| Parameter | CDK context key | Example |
|-----------|-----------------|---------|
| VPC ID | `vpcId` | `vpc-0abc123def456` |
| Private subnet IDs | `privateSubnetIds` | `subnet-aaa,subnet-bbb` |
| Private subnet AZs | `privateSubnetAzs` | `us-east-1a,us-east-1b` |
| VPC CIDR | `vpcCidr` | `10.0.0.0/16` |
| Google OAuth Client ID | `oidcClientId` | `242196034593-xxxx.apps.googleusercontent.com` |
| Google OAuth Client Secret | `oidcClientSecret` | `GOCSPX-...` |
| Admin group name | `adminGroupName` | `claude-gateway-admins` |

The OIDC issuer is always `https://accounts.google.com` — pass it as `-c oidcIssuer=https://accounts.google.com`.

### How to look up your VPC values

```bash
# List VPCs — find yours by name/tag
aws ec2 describe-vpcs --query "Vpcs[*].{VpcId:VpcId,CidrBlock:CidrBlock,Name:Tags[?Key=='Name'].Value|[0]}" --output table

# Get VPC CIDR
aws ec2 describe-vpcs --vpc-id <your-vpc-id> --query "Vpcs[0].CidrBlock" --output text

# List subnets in your VPC
aws ec2 describe-subnets --filters "Name=vpc-id,Values=<your-vpc-id>" \
  --query "Subnets[*].{SubnetId:SubnetId,AZ:AvailabilityZone,CidrBlock:CidrBlock,Name:Tags[?Key=='Name'].Value|[0]}" --output table
```

You need at least **2 private subnets** (for the gateway) and **2 public subnets** (for the admin console) in different availability zones. Private subnets must have a NAT Gateway for outbound internet access.

---

## Deploy

### Step 1 — Prepare the gateway config

Copy the Google Workspace template into place:

```bash
cp gateway/gateway.yaml.google gateway/gateway.yaml
```

Edit `gateway/gateway.yaml` to set your email domain restriction:

```yaml
  allowed_email_domains: [yourcompany.com]
```

### Step 2 — Clone, install, bootstrap

```bash
cd sample-claude-apps-gateway-on-aws/cdk
npm install

# First time only:
CDK_DEFAULT_ACCOUNT=<your-account-id> CDK_DEFAULT_REGION=<your-region> \
npx cdk bootstrap aws://<your-account-id>/<your-region>
```

### Step 3 — Deploy all stacks

```bash
CDK_DEFAULT_ACCOUNT=<your-account-id> CDK_DEFAULT_REGION=<your-region> \
npx cdk deploy --all --require-approval never \
  -c vpcId=<your-vpc-id> \
  -c privateSubnetIds=<subnet-1>,<subnet-2> \
  -c privateSubnetAzs=<az-1>,<az-2> \
  -c vpcCidr=<your-vpc-cidr> \
  -c oidcIssuer=https://accounts.google.com \
  -c oidcClientId=<your-google-client-id>.apps.googleusercontent.com \
  -c oidcClientSecret="GOCSPX-<your-secret>" \
  -c adminGroupName=claude-gateway-admins
```

This takes **25-35 minutes**. When complete, note the outputs:

```
ClaudeGatewayStack.GatewayEndpoint = https://cl-xxxx.ecs.<region>.on.aws
ClaudeGatewayAdminConsoleStack.AdminConsoleEndpoint = https://cl-yyyy.ecs.<region>.on.aws
```

### Step 4 — Update the Google OAuth redirect URI

Go back to [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials), edit your OAuth client, and replace the placeholder redirect URI with:

```
https://<your-gateway-endpoint>/oauth/callback
```

Save. This must match exactly, including the `/oauth/callback` path.

### Step 5 — Verify

```bash
# Gateway health check (requires VPN to private subnet)
curl -s https://<gateway-endpoint>/healthz
# Expected: {"status":"ok"}

# OIDC discovery (confirms issuer config)
curl -s https://<gateway-endpoint>/.well-known/oauth-authorization-server | jq .issuer
# Expected: "https://accounts.google.com"
```

Open the admin console in your browser:
```
https://<admin-console-endpoint>/signin
```

Sign in with your Google Workspace account. You should land on the spend dashboard.

---

## Wire developer machines

Push this JSON file to each developer's machine:

```json
{
  "forceLoginMethod": "gateway",
  "forceLoginGatewayUrl": "https://<your-gateway-endpoint>"
}
```

| Platform | File path | Deployment method |
|----------|-----------|-------------------|
| macOS | `/Library/Application Support/ClaudeCode/managed-settings.json` | Jamf, or manual with `sudo` |
| Linux / WSL | `/etc/claude-code/managed-settings.json` | Ansible, Chef, Puppet, or manual |
| Windows | `C:\Program Files\ClaudeCode\managed-settings.json` | Intune, Group Policy |

Each developer then runs:
```bash
claude /login
```
→ Browser opens → Google SSO → done. No API keys, no AWS credentials on their machine.

---

## Optional: Enable group-based policies

By default, the gateway uses a single `match: {}` catch-all policy that gives all authenticated users the same model access. To enable **tiered access by Google Group membership**, add the `google_groups` block to `gateway.yaml`:

```yaml
oidc:
  issuer: https://accounts.google.com
  client_id: ${OIDC_CLIENT_ID}
  client_secret: ${OIDC_CLIENT_SECRET}
  userinfo_fallback: true
  scopes: [openid, profile, email]
  extra_auth_params: { access_type: offline, prompt: consent }
  allowed_email_domains: [yourcompany.com]
  # Enable Google Groups lookup via Directory API
  google_groups:
    service_account_json_path: /secrets/google-sa.json
    admin_email: admin@yourcompany.com
```

Then add group-scoped policies:

```yaml
managed:
  policies:
    - match: { groups: [claude-leads@yourcompany.com] }
      cli:
        availableModels: [claude-opus-4-8, claude-sonnet-5, claude-haiku-4-5]
        enforceAvailableModels: true
    - match: { groups: [claude-engineers@yourcompany.com] }
      cli:
        availableModels: [claude-sonnet-5, claude-haiku-4-5]
        enforceAvailableModels: true
    - match: {}
      cli:
        availableModels: [claude-haiku-4-5]
        enforceAvailableModels: true
```

### Requirements for google_groups

1. **Create a GCP service account** in the same project as your OAuth client.
2. **Enable domain-wide delegation** for that service account.
3. **Grant the scope** `https://www.googleapis.com/auth/admin.directory.group.readonly` in the Google Admin Console → Security → API Controls → Domain-wide delegation.
4. **Set `admin_email`** to a Google Workspace admin account the service account will impersonate (required by the Directory API).
5. **Mount the service account JSON key** as a secret in the ECS task (via Secrets Manager or a mounted volume).

---

## Admin console features

| Feature | What it does |
|---------|-------------|
| **Spend Dashboard** | Real-time per-user cost breakdown across all Claude models |
| **Spend Limits** | Set daily/weekly/monthly caps per user, per group, or org-wide |
| **Model Access** | Enable/disable Claude models from the live Bedrock catalog (no image rebuild) |
| **Audit Log** | Every admin action traced to the real admin's Google identity |

---

## Day-2 operations

| Task | How |
|------|-----|
| Add/remove developers | Add/remove from Google Workspace. Session expires within `ttl_hours` (8h). |
| Change model access | Admin console → Models → toggle checkboxes → Apply |
| Set spend limits | Admin console → Limits → create/edit/delete |
| Offboard a user | Remove from Google Workspace. No credential rotation needed. |
| Change gateway config | Edit `gateway.yaml` → rebuild image → push to ECR → force new deployment |
| Upgrade Claude version | Rebuild gateway image (new binary auto-downloaded) → push → redeploy |
| Tear down everything | `npx cdk destroy --all` with the same `-c` context values |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `redirect_uri_mismatch` at Google sign-in | Redirect URI doesn't match | Set exactly `https://<gateway-endpoint>/oauth/callback` in Google Console |
| `invalid_scope` error | Wrong scopes configured | Ensure `gateway.yaml` uses `scopes: [openid, profile, email]` only |
| Admin console shows "Not Authorized" | User not in admin group | Add user to the admin group in Google Admin Console |
| `claude /login` hangs | VPN not connected or managed-settings not in system path | Connect VPN, verify file at the correct system-level path |
| Gateway crash-loops | OIDC client secret wrong or missing | Check Secrets Manager value matches Google Console |
| "access_denied" after login | `allowed_email_domains` doesn't match | Verify domain in `gateway.yaml` matches your Workspace domain |
| Models return 400 | Bedrock model access not enabled | Enable model access in the AWS Console → Bedrock → Model access |
| Build machine timeout | Subnets lack NAT Gateway | Ensure private subnets route to a NAT Gateway for outbound internet |

---

## Security posture

- **Zero credentials on developer machines** — only the gateway URL is pushed
- **Private gateway** — internal ALB, reachable only via your existing VPN/Direct Connect
- **All inference stays in your AWS account** — Amazon Bedrock only, no third-party calls
- **SSO-gated access** — authentication and admin authorization via Google Workspace groups
- **Short-lived tokens** — 8-hour TTL with silent refresh; revoking Workspace access cuts off users within one TTL window
- **Container image verified** — Claude binary GPG-signed and SHA256-checked at build time
- **Aurora encrypted at rest** — RDS-managed credentials, auto-rotating
- **Every admin action audited** — traced to the real user's Google identity (`oidc:<sub>`)
- **No shared credentials** — the admin console uses the signed-in admin's own token, not a shared API key

---

## Cleanup

```bash
CDK_DEFAULT_ACCOUNT=<account> CDK_DEFAULT_REGION=<region> \
npx cdk destroy --all \
  -c vpcId=<vpc-id> \
  -c privateSubnetIds=<subnets> \
  -c privateSubnetAzs=<azs> \
  -c vpcCidr=<cidr> \
  -c oidcIssuer=https://accounts.google.com \
  -c oidcClientId=<client-id> \
  -c oidcClientSecret=<secret> \
  -c adminGroupName=<group>
```

This removes all deployed AWS resources. Aurora data is not recoverable after destruction. Delete the Google OAuth client separately if no longer needed.
