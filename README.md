# Maagy Autonomous Agent

Telegram-controlled automation for running Antigravity CLI against Next.js repositories.

The system receives commands from Telegram, dispatches a GitHub Actions workflow, runs Antigravity on a self-hosted runner, verifies the project, and pushes successful changes to `agent-main`.

## Architecture

```text
Telegram Bot
  -> Cloudflare Worker
  -> GitHub Actions workflow_dispatch
  -> self-hosted GitHub Actions runner
  -> Antigravity CLI
  -> Next.js verification
  -> git commit and push to agent-main
```

Antigravity runs on the local machine through the self-hosted runner. This allows the workflow to use the local `agy` installation, local authentication, and available Antigravity quota.

## Repository Layout

```text
.github/workflows/autonomous-agent.yml   GitHub Actions workflow
scripts/agent-loop.mjs                   Local controller executed by the runner
scripts/smoke-test.mjs                   Safe local smoke test
cloudflare-worker/src/worker.js          Telegram webhook Worker
cloudflare-worker/wrangler.toml.example  Worker configuration template
```

## Requirements

- Node.js available on the self-hosted runner.
- Git available on the self-hosted runner.
- Antigravity CLI available as `agy`.
- A GitHub repository containing this automation project.
- A GitHub self-hosted runner registered to the automation repository.
- A Telegram bot token.
- A Cloudflare account for the Worker.

## GitHub Configuration

Create a fine-grained GitHub token for the runner.

Recommended permissions:

```text
Repository access: selected repositories only
Contents: Read and write
Actions: Read and write
Metadata: Read-only
```

The token must include:

- the automation repository, so workflows can run correctly;
- each target repository the agent is allowed to clone and push to.

Add this token to the automation repository:

```text
Settings -> Secrets and variables -> Actions -> Secrets
Name: AGENT_GITHUB_TOKEN
```

Add the allowed workspace root:

```text
Settings -> Secrets and variables -> Actions -> Variables
Name: AGENT_ALLOWED_ROOT
Value: C:\Users\shrid\OneDrive\Documents\NextJS\agent-space
```

All workflow `workspace_path` values must be inside `AGENT_ALLOWED_ROOT`.

For rich `/status`, add the status endpoint and shared token:

```text
Settings -> Secrets and variables -> Actions -> Secrets
Name: STATUS_UPDATE_TOKEN

Settings -> Secrets and variables -> Actions -> Variables
Name: STATUS_UPDATE_URL
Value: https://<worker-url>/status-update
```

Use the same `STATUS_UPDATE_TOKEN` value for the GitHub secret and Cloudflare Worker secret.

## Local Smoke Test

Run from the automation repository:

```bash
npm run smoke
```

This checks the controller's stop path. It does not call Antigravity, GitHub, or Telegram.

## GitHub Actions Smoke Test

After the self-hosted runner is online, run the `Autonomous Agent` workflow manually:

```text
command: stop
target_repo: Shridharrrr/test1
workspace_path: C:\Users\shrid\OneDrive\Documents\NextJS\agent-space\smoke
prompt: Stop smoke test
max_iterations: 5
branch: agent-main
agy_model: Gemini 3.1 Pro (High)
```

Expected result:

```text
C:\Users\shrid\OneDrive\Documents\NextJS\agent-space\smoke\.agent-stop
```

## Workflow Inputs

The workflow is defined in:

```text
.github/workflows/autonomous-agent.yml
```

Supported `command` values:

```text
start
stop
models
quota
```

Required workflow inputs:

```text
target_repo      GitHub repository as owner/repo or HTTPS URL
workspace_path   Absolute path on the self-hosted runner
```

Optional inputs:

```text
prompt            Build or improvement prompt
max_iterations    Maximum loop count, capped to 5
branch            Target branch, defaults to agent-main
agy_model         Antigravity model, defaults to Gemini 3.1 Pro (High)
agy_fallback_models
                  Comma-separated fallback models used when quota is reached
telegram_chat_id  Chat ID for progress messages
```

## Verification

The controller verifies the project after each Antigravity run.

It always runs:

```bash
npm install
```

It also runs these scripts when present in `package.json`:

```bash
npm run lint
npm run typecheck
npm run build
npm run test
```

A `build` script is required. If verification passes, the controller commits and pushes to the configured branch. If verification fails, the failure output is passed into the next Antigravity iteration until the run passes or reaches the iteration limit.

## Cloudflare Worker Setup

Copy the example config:

```bash
cp cloudflare-worker/wrangler.toml.example cloudflare-worker/wrangler.toml
```

Configure Worker variables:

```toml
[vars]
GITHUB_OWNER = "Shridharrrr"
GITHUB_REPO = "maagy"
GITHUB_WORKFLOW_FILE = "autonomous-agent.yml"
DEFAULT_WORKSPACE_PATH = "C:\\Users\\shrid\\OneDrive\\Documents\\NextJS\\agent-space\\telegram-run"
DEFAULT_WORKSPACE_ROOT = "C:\\Users\\shrid\\OneDrive\\Documents\\NextJS\\agent-space"
DEFAULT_TARGET_REPO = "Shridharrrr/test1"
DEFAULT_AGY_MODEL = "Gemini 3.1 Pro (High)"
DEFAULT_AGY_FALLBACK_MODELS = "Gemini 3.5 Flash (High),Gemini 3.5 Flash (Medium),Gemini 3.5 Flash (Low)"
```

Add Worker secrets:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_ALLOWED_USER_ID
wrangler secret put GITHUB_TOKEN
wrangler secret put STATUS_UPDATE_TOKEN
```

Optional: create a KV namespace for rich `/status` storage:

```bash
wrangler kv namespace create STATUS_KV
```

Add the generated binding to `cloudflare-worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "STATUS_KV"
id = "<namespace-id>"
```

Deploy:

```bash
cd cloudflare-worker
wrangler deploy
```

Set the Telegram webhook:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<worker-url>/telegram"
```

## Telegram Commands

Build into a named workspace under `DEFAULT_WORKSPACE_ROOT`:

```text
/build Shridharrrr/test1 | telegram-test | Improve the homepage and keep build passing
```

This expands to:

```text
C:\Users\shrid\OneDrive\Documents\NextJS\agent-space\telegram-test
```

The Telegram command requires a workspace name. Use one workspace name per target repository or task. The workspace name must be a single folder name, not an absolute path.

Override model, iterations, or branch:

```text
/build Shridharrrr/test1 | telegram-test | Add a pricing section | model=Gemini 3.1 Pro (High) | fallback=Gemini 3.5 Flash (High),Gemini 3.5 Flash (Medium) | iterations=3 | branch=agent-main
```

Stop a run:

```text
/stop Shridharrrr/test1 | telegram-test
```

Check recent workflow runs:

```text
/status
```

When `STATUS_KV`, `STATUS_UPDATE_URL`, and `STATUS_UPDATE_TOKEN` are configured, `/status` reports the active run state, repository, branch, model, iteration, and last verification step. Without KV, `/status` falls back to recent GitHub Actions runs.

List Antigravity models from the self-hosted runner:

```text
/models
```

Probe quota support:

```text
/quota
```

The current Antigravity CLI exposes model listing but does not expose exact quota usage through a CLI command. `/quota` reports that limitation and confirms whether the local CLI is reachable.

## Progress Messages

During a run, the controller sends Telegram updates for:

- repository preparation;
- each iteration;
- Antigravity start and finish;
- each verification command;
- commit and push;
- final completion or failure.

After successful verification, the controller attempts to start the built Next.js app, capture the homepage with Playwright, and send the screenshot to Telegram. Screenshot capture is best-effort; failure to capture a screenshot does not block commit or push.

## Workspace Behavior

The first run against an empty workspace clones the target repository.

Later runs against the same workspace reuse the existing clone:

```text
fetch origin
checkout agent-main
pull latest agent-main
run Antigravity
verify
commit
push
```

Use one workspace per target repository or task. Do not point different repositories at the same workspace name.

## Safety Limits

- Commands are accepted only from `TELEGRAM_ALLOWED_USER_ID`.
- Workspaces must be inside `AGENT_ALLOWED_ROOT`.
- Iterations are capped at 5.
- The agent pushes to `agent-main` by default.
- `.agent-stop` can be used to stop a workspace run.

## Troubleshooting

`Workspace must be inside AGENT_ALLOWED_ROOT`

Use a `workspace_path` under the configured root.

`Repository not found`

Check that the target repository exists and that `AGENT_GITHUB_TOKEN` has access to it.

Telegram command gets no reply

Check the Worker URL, Telegram webhook, and Worker secrets:

```bash
wrangler secret list
```

GitHub workflow does not start

Check that the Worker `GITHUB_TOKEN` can dispatch workflows in the automation repository and that `GITHUB_OWNER`, `GITHUB_REPO`, and `GITHUB_WORKFLOW_FILE` are correct.

Runner stays queued

Start the self-hosted runner on the local machine.
