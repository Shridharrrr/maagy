# Maagy Autonomous Agent

Zero-cost control plane for starting an Antigravity CLI coding loop from Telegram.

## Architecture

```text
Telegram
  -> Cloudflare Worker
  -> GitHub workflow_dispatch
  -> GitHub self-hosted runner on your machine
  -> Antigravity CLI
  -> Next.js verification
  -> direct push to agent-main
```

The Cloudflare Worker only triggers jobs. Antigravity runs on your own machine through a self-hosted GitHub Actions runner, which lets it use your local Antigravity login and free quota.

## GitHub Setup

1. Push this automation project to GitHub.
2. Add a self-hosted runner to that repo from GitHub: **Settings -> Actions -> Runners**.
3. Install and start the runner on the same machine where `agy` is authenticated.
4. Add repository secret `AGENT_GITHUB_TOKEN`.
   - It needs permission to clone and push the target repos.
   - Fine-grained PAT is best; grant only the repos you want.
5. Optional repository secrets:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
6. Recommended repository variable:
   - `AGENT_ALLOWED_ROOT`, for example `C:\Users\shrid\OneDrive\Documents\AI-Agent-Workspaces`

## Workflow Inputs

The workflow file is `.github/workflows/autonomous-agent.yml`.

Required:

- `target_repo`: `owner/repo` or an HTTPS GitHub URL.
- `workspace_path`: absolute folder path on your self-hosted runner.

Optional:

- `prompt`: what to build or improve.
- `max_iterations`: capped to 5 by the controller.
- `branch`: defaults to `agent-main`.
- `agy_model`: defaults to `Gemini 3.1 Pro (High)`.

## Cloudflare Worker Setup

1. Copy `cloudflare-worker/wrangler.toml.example` to `cloudflare-worker/wrangler.toml`.
2. Fill Worker variables in `wrangler.toml` or the Cloudflare dashboard:
   - `GITHUB_OWNER`
   - `GITHUB_REPO`
   - `GITHUB_WORKFLOW_FILE`
   - `DEFAULT_WORKSPACE_PATH`
   - `DEFAULT_TARGET_REPO`
3. Add secrets:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_ALLOWED_USER_ID
wrangler secret put GITHUB_TOKEN
```

4. Deploy:

```bash
cd cloudflare-worker
wrangler deploy
```

5. Set the Telegram webhook:

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://<worker-url>/telegram"
```

## Telegram Commands

```text
/build owner/repo | C:\path\to\empty-folder | Build a polished Next.js SaaS dashboard
/build owner/repo | Build a polished Next.js SaaS dashboard
/stop owner/repo | C:\path\to\folder
```

If the workspace has no project yet, the Antigravity prompt tells it to create a Next.js app. The controller then runs `npm install`, any available `lint`, `typecheck`, `build`, and `test` scripts, commits passing changes, and pushes them to `agent-main`.
