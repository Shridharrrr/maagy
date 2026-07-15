import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const env = process.env;
const targetRepo = required("TARGET_REPO");
const workspacePath = resolve(required("WORKSPACE_PATH"));
const targetBranch = env.TARGET_BRANCH || "agent-main";
const maxIterations = Math.min(parseInt(env.MAX_ITERATIONS || "5", 10) || 5, 5);
const agyCommand = env.AGY_COMMAND || "agy";
const agyModel = env.AGY_MODEL || "Gemini 3.1 Pro (High)";
const agyFallbackModels = parseFallbackModels(env.AGY_FALLBACK_MODELS);
const actionCommand = (env.ACTION_COMMAND || "start").toLowerCase();
const stopFile = resolve(workspacePath, ".agent-stop");
const runId = env.GITHUB_RUN_ID || `${Date.now()}`;
const runState = {
  run_id: runId,
  state: "starting",
  repo: targetRepo,
  branch: targetBranch,
  model: agyModel,
  workspace: workspacePath,
  iteration: 0,
  max_iterations: maxIterations,
  step: "starting",
  last_verification: "none",
  workflow_url: workflowUrl()
};

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await updateStatus({ state: "failed", step: "failed", last_verification: error.message });
  await notify(`Autonomous agent failed: ${error.message}`);
  await cleanRemoteUrl();
  process.exit(1);
});

async function main() {
  assertWorkspaceAllowed(workspacePath);
  mkdirSync(workspacePath, { recursive: true });

  if (actionCommand === "stop") {
    writeFileSync(stopFile, `Stop requested at ${new Date().toISOString()}\n`);
    await updateStatus({ state: "stopping", step: "stop requested" });
    await notify(`Stop requested for ${targetRepo} in ${workspacePath}`);
    return;
  }

  if (actionCommand === "models") {
    await updateStatus({ state: "running", step: "listing models" });
    const models = await run(agyCommand, ["models"], { cwd: workspacePath, reject: false });
    await updateStatus({ state: models.code === 0 ? "complete" : "failed", step: "models complete" });
    await notify(models.code === 0 ? `Available Antigravity models:\n${models.output.trim()}` : `Could not read models:\n${models.output.trim()}`);
    return;
  }

  if (actionCommand === "quota") {
    await updateStatus({ state: "running", step: "probing quota support" });
    const models = await run(agyCommand, ["models"], { cwd: workspacePath, reject: false });
    await updateStatus({ state: "complete", step: "quota probe complete" });
    await notify(
      [
        "Antigravity CLI does not currently expose a quota/usage command in this install.",
        "You can check quota in the Antigravity UI/account surface.",
        "",
        models.code === 0 ? `CLI is authenticated enough to list models:\n${models.output.trim()}` : `Model probe failed:\n${models.output.trim()}`
      ].join("\n")
    );
    return;
  }

  if (existsSync(stopFile)) unlinkSync(stopFile);
  await updateStatus({ state: "running", step: "run started" });
  await notify(
    [
      "Agent run started",
      `repo: ${targetRepo}`,
      `branch: ${targetBranch}`,
      `model: ${agyModel}`,
      agyFallbackModels.length ? `fallbacks: ${agyFallbackModels.join(", ")}` : "",
      `workspace: ${workspacePath}`,
      `max iterations: ${maxIterations}`
    ].filter(Boolean).join("\n")
  );
  await updateStatus({ step: "preparing repository" });
  await notify("Preparing repository...");
  await prepareRepository();
  await updateStatus({ step: "repository ready" });
  await notify("Repository ready. Starting autonomous loop.");

  let lastVerification = "";
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (existsSync(stopFile)) {
      await updateStatus({ state: "stopped", iteration, step: "stopped by .agent-stop" });
      await notify(`Stopped before iteration ${iteration} because .agent-stop exists.`);
      return;
    }

    console.log(`\n=== Iteration ${iteration}/${maxIterations} ===`);
    await updateStatus({ iteration, step: "running Antigravity" });
    await notify(`Iteration ${iteration}/${maxIterations}: running Antigravity...`);
    await runAntigravity(iteration, lastVerification);
    await updateStatus({ iteration, step: "running verification" });
    await notify(`Iteration ${iteration}/${maxIterations}: Antigravity finished. Running verification...`);

    const verification = await verifyNextProject(iteration);
    lastVerification = verification.output.slice(-12000);

    if (verification.ok) {
      await updateStatus({ iteration, step: "capturing screenshot", last_verification: "checks passed" });
      await captureAndSendScreenshot();
      await updateStatus({ iteration, step: "committing and pushing", last_verification: "checks passed" });
      await notify(`Iteration ${iteration}/${maxIterations}: checks passed. Committing and pushing...`);
      const committed = await commitAndPush(iteration);
      await updateStatus({
        state: "complete",
        iteration,
        step: committed ? "pushed" : "complete with no changes",
        last_verification: "checks passed"
      });
      await notify(
        committed
          ? [
              "Agent run complete",
              `iteration: ${iteration}/${maxIterations}`,
              `result: checks passed and pushed to ${targetBranch}`,
              `repo: ${targetRepo}`
            ].join("\n")
          : [
              "Agent run complete",
              `iteration: ${iteration}/${maxIterations}`,
              "result: checks passed, no file changes to commit",
              `repo: ${targetRepo}`
            ].join("\n")
      );
      await cleanRemoteUrl();
      return;
    }

    console.log(lastVerification);
    await updateStatus({
      iteration,
      step: "verification failed",
      last_verification: verification.summary || "checks failed"
    });
    await notify(
      [
        `Iteration ${iteration}/${maxIterations}: checks failed.`,
        iteration < maxIterations ? "Continuing with failure output in the next prompt." : "No iterations remain.",
        verification.summary ? `last check: ${verification.summary}` : ""
      ].filter(Boolean).join("\n")
    );
  }

  throw new Error(`Reached ${maxIterations} iterations without passing verification.`);
}

function required(name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertWorkspaceAllowed(path) {
  const allowedRoot = env.AGENT_ALLOWED_ROOT && resolve(env.AGENT_ALLOWED_ROOT);
  if (!allowedRoot) {
    console.warn("AGENT_ALLOWED_ROOT is not set. Workspace path is unrestricted.");
    return;
  }

  const pathFromRoot = relative(allowedRoot, path);
  if (pathFromRoot.startsWith("..") || resolve(pathFromRoot) === pathFromRoot) {
    throw new Error(
      [
        "Workspace must be inside AGENT_ALLOWED_ROOT.",
        `AGENT_ALLOWED_ROOT: ${allowedRoot}`,
        `WORKSPACE_PATH: ${path}`,
        "Use a workspace path like AGENT_ALLOWED_ROOT\\project-name."
      ].join("\n")
    );
  }
}

async function prepareRepository() {
  const cloneUrl = buildCloneUrl(targetRepo);
  const remoteOk = await exitsZero("git", ["ls-remote", cloneUrl], workspacePath, [env.GITHUB_TOKEN]);
  if (!remoteOk) {
    throw new Error(
      [
        `Cannot access target repo: ${targetRepo}`,
        "Check that the repo exists and AGENT_GITHUB_TOKEN has Contents: Read and write access.",
        "If the repo is private, the token must be allowed for that exact repository."
      ].join("\n")
    );
  }

  if (!existsSync(resolve(workspacePath, ".git"))) {
    await run("git", ["clone", cloneUrl, "."], { cwd: workspacePath, mask: [env.GITHUB_TOKEN] });
  }

  await run("git", ["remote", "set-url", "origin", buildCloneUrl(targetRepo)], {
    cwd: workspacePath,
    mask: [env.GITHUB_TOKEN]
  });
  await run("git", ["config", "user.name", env.AGENT_GIT_NAME || "Antigravity Agent"], { cwd: workspacePath });
  await run("git", ["config", "user.email", env.AGENT_GIT_EMAIL || "agent@example.local"], { cwd: workspacePath });
  await run("git", ["fetch", "origin"], { cwd: workspacePath });

  const branchExists = await exitsZero("git", ["rev-parse", "--verify", `origin/${targetBranch}`], workspacePath);
  if (branchExists) {
    await run("git", ["checkout", targetBranch], { cwd: workspacePath });
    await run("git", ["pull", "--ff-only", "origin", targetBranch], { cwd: workspacePath });
  } else {
    await run("git", ["checkout", "-B", targetBranch], { cwd: workspacePath });
  }
}

function buildCloneUrl(repo) {
  if (repo.startsWith("http://") || repo.startsWith("https://")) return addToken(repo);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error("TARGET_REPO must be owner/repo or an HTTPS GitHub URL");
  }
  return addToken(`https://github.com/${repo}.git`);
}

function addToken(url) {
  if (!env.GITHUB_TOKEN || !url.startsWith("https://github.com/")) return url;
  return url.replace("https://github.com/", `https://x-access-token:${env.GITHUB_TOKEN}@github.com/`);
}

function cleanRepoUrl(repo) {
  if (repo.startsWith("https://github.com/")) return repo;
  if (/^[\w.-]+\/[\w.-]+$/.test(repo)) return `https://github.com/${repo}.git`;
  return repo;
}

async function runAntigravity(iteration, lastVerification) {
  const prompt = [
    `You are building or improving a Next.js project in this workspace: ${workspacePath}`,
    `Primary user request: ${env.AGENT_PROMPT || "Create a polished, production-ready Next.js app."}`,
    "",
    "Hard requirements:",
    "- Work autonomously and make the necessary code changes.",
    "- If the folder is empty or lacks a Next.js app, create one.",
    "- Prefer TypeScript, App Router, accessible UI, responsive layout, and clean scripts.",
    "- Keep the project installable with npm.",
    "- Do not push or commit; the controller will verify and push.",
    "- Treat passing install/build/lint/test checks as the definition of done.",
    "",
    lastVerification ? `Previous verification output to fix:\n${lastVerification}` : "This is the first iteration.",
    `Iteration: ${iteration}/${maxIterations}`
  ].join("\n");

  const modelsToTry = [agyModel, ...agyFallbackModels.filter((model) => model !== agyModel)];
  let lastResult = null;

  for (const model of modelsToTry) {
    await updateStatus({ iteration, step: `running Antigravity with ${model}`, model });
    if (model !== agyModel) {
      await notify(`Primary model quota failed. Trying fallback model: ${model}`);
    }

    const args = [
      "--add-dir",
      workspacePath,
      "--model",
      model,
      "--mode",
      "accept-edits",
      "--print-timeout",
      env.AGY_PRINT_TIMEOUT || "45m",
      "--print",
      prompt
    ];

    if ((env.AGY_SKIP_PERMISSIONS || "true").toLowerCase() === "true") {
      args.unshift("--dangerously-skip-permissions");
    }

    lastResult = await run(agyCommand, args, { cwd: workspacePath, reject: false });
    if (lastResult.code === 0) {
      await updateStatus({ iteration, step: `Antigravity complete with ${model}`, model });
      return;
    }

    if (!isQuotaError(lastResult.output)) {
      throw new Error(`${agyCommand} ${args.join(" ")} exited with ${lastResult.code}`);
    }

    await notify(`Quota reached for ${model}.`);
  }

  const resetHint = extractResetHint(lastResult?.output || "");
  throw new Error(
    [
      "Antigravity quota reached for all configured models.",
      `tried: ${modelsToTry.join(", ")}`,
      resetHint ? `reset: ${resetHint}` : ""
    ].filter(Boolean).join("\n")
  );
}

async function verifyNextProject(iteration) {
  const packageJsonPath = resolve(workspacePath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { ok: false, output: "package.json was not created.", summary: "missing package.json" };
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const scripts = packageJson.scripts || {};
  const commands = [["npm", ["install"]]];

  for (const script of ["lint", "typecheck", "build", "test"]) {
    if (scripts[script]) commands.push(["npm", ["run", script]]);
  }

  if (!scripts.build) {
    return { ok: false, output: "package.json is missing a build script.", summary: "missing build script" };
  }

  let output = "";
  for (const [command, args] of commands) {
    const label = `${command} ${args.join(" ")}`;
    await updateStatus({ iteration, step: `verifying ${label}`, last_verification: label });
    await notify(`Iteration ${iteration}/${maxIterations}: verifying \`${label}\`...`);
    const result = await run(command, args, { cwd: workspacePath, reject: false });
    output += `\n$ ${label}\n${result.output}\n`;
    if (result.code !== 0) {
      await updateStatus({ iteration, step: "verification failed", last_verification: `${label} failed` });
      await notify(`Iteration ${iteration}/${maxIterations}: \`${label}\` failed.`);
      return { ok: false, output, summary: `${label} failed` };
    }
    await updateStatus({ iteration, step: `passed ${label}`, last_verification: `${label} passed` });
    await notify(`Iteration ${iteration}/${maxIterations}: \`${label}\` passed.`);
  }

  return { ok: true, output };
}

async function commitAndPush(iteration) {
  const status = await run("git", ["status", "--porcelain"], { cwd: workspacePath, reject: false });
  if (!status.output.trim()) return false;

  await run("git", ["add", "-A"], { cwd: workspacePath });
  await run("git", ["commit", "-m", `agent: autonomous iteration ${iteration}`], { cwd: workspacePath });
  await run("git", ["push", "-u", "origin", targetBranch], { cwd: workspacePath, mask: [env.GITHUB_TOKEN] });
  await cleanRemoteUrl();
  return true;
}

async function cleanRemoteUrl() {
  if (!existsSync(resolve(workspacePath, ".git"))) return;
  await run("git", ["remote", "set-url", "origin", cleanRepoUrl(targetRepo)], { cwd: workspacePath, reject: false });
}

async function exitsZero(command, args, cwd, mask = []) {
  const result = await run(command, args, { cwd, reject: false, mask });
  return result.code === 0;
}

function run(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const mask = options.mask || [];
  const normalized = normalizeCommand(command, args);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(normalized.command, normalized.args, { cwd, shell: false });
    let output = "";

    const collect = (chunk) => {
      let text = chunk.toString();
      for (const secret of mask) {
        if (secret) text = text.split(secret).join("***");
      }
      output += text;
      process.stdout.write(text);
    };

    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const result = { code, output };
      if (code !== 0 && options.reject !== false) {
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with ${code}`));
      } else {
        resolvePromise(result);
      }
    });
  });
}

function normalizeCommand(command, args) {
  if (process.platform === "win32" && (command === "npm" || command === "npx")) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/c", [command, ...args].map(quoteCmdArg).join(" ")]
    };
  }

  return { command, args };
}

function quoteCmdArg(value) {
  const text = String(value);
  if (/^[\w:./@\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function parseFallbackModels(value) {
  if (!value) return [];
  return value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
}

function isQuotaError(output) {
  return /quota reached|subscription.*limits|increase your limits/i.test(output || "");
}

function extractResetHint(output) {
  const match = String(output || "").match(/Resets in [^\r\n.]+/i);
  return match?.[0] || "";
}

async function captureAndSendScreenshot() {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const packageJsonPath = resolve(workspacePath, "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  if (!packageJson.scripts?.start) {
    await notify("Screenshot skipped: package.json has no start script.");
    return;
  }

  const port = String(4300 + Math.floor(Math.random() * 1000));
  const previewDir = resolve(workspacePath, ".agent-preview");
  const screenshotPath = resolve(previewDir, "homepage.png");
  mkdirSync(previewDir, { recursive: true });

  let server;
  try {
    await notify("Starting local Next.js server for screenshot...");
    server = startProcess("npm", ["run", "start", "--", "--hostname", "127.0.0.1", "-p", port], { cwd: workspacePath });
    await waitForUrl(`http://127.0.0.1:${port}`, 90000);

    await notify("Capturing homepage screenshot...");
    await run("npx", ["-y", "playwright@latest", "install", "chromium"], { cwd: workspacePath, reject: false });
    const result = await run(
      "npx",
      ["-y", "playwright@latest", "screenshot", "--browser=chromium", "--wait-for-timeout=1000", `http://127.0.0.1:${port}`, screenshotPath],
      { cwd: workspacePath, reject: false }
    );

    if (result.code !== 0 || !existsSync(screenshotPath)) {
      await notify("Screenshot skipped: Playwright capture failed.");
      return;
    }

    await sendPhoto(screenshotPath, `Latest homepage preview for ${targetRepo} on ${targetBranch}`);
  } catch (error) {
    await notify(`Screenshot skipped: ${error.message}`);
  } finally {
    if (server) await killProcessTree(server);
    if (existsSync(screenshotPath)) unlinkSync(screenshotPath);
  }
}

function startProcess(command, args, options = {}) {
  const normalized = normalizeCommand(command, args);
  const child = spawn(normalized.command, normalized.args, { cwd: options.cwd || process.cwd(), shell: false });
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));
  return child;
}

async function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await sleep(1000);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function killProcessTree(child) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    await run("taskkill", ["/pid", String(child.pid), "/t", "/f"], { reject: false });
  } else {
    child.kill("SIGTERM");
  }
}

async function sendPhoto(filePath, caption) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const form = new FormData();
  form.set("chat_id", env.TELEGRAM_CHAT_ID);
  form.set("caption", caption.slice(0, 1000));
  form.set("photo", new Blob([readFileSync(filePath)], { type: "image/png" }), "homepage.png");

  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendPhoto`, {
      method: "POST",
      body: form
    });
  } catch (error) {
    console.warn(`Telegram screenshot failed: ${error.message}`);
  }
}

async function updateStatus(partial) {
  Object.assign(runState, partial, { updated_at: new Date().toISOString() });

  if (!env.STATUS_UPDATE_URL || !env.STATUS_UPDATE_TOKEN) return;

  try {
    await fetch(env.STATUS_UPDATE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.STATUS_UPDATE_TOKEN}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(runState)
    });
  } catch (error) {
    console.warn(`Status update failed: ${error.message}`);
  }
}

function workflowUrl() {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return "";
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

async function notify(message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message.slice(0, 3900) })
    });
  } catch (error) {
    console.warn(`Telegram notification failed: ${error.message}`);
  }
}
