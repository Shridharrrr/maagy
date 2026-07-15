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
const actionCommand = (env.ACTION_COMMAND || "start").toLowerCase();
const stopFile = resolve(workspacePath, ".agent-stop");

main().catch(async (error) => {
  console.error(error.stack || error.message);
  await notify(`Autonomous agent failed: ${error.message}`);
  process.exit(1);
});

async function main() {
  assertWorkspaceAllowed(workspacePath);
  mkdirSync(workspacePath, { recursive: true });

  if (actionCommand === "stop") {
    writeFileSync(stopFile, `Stop requested at ${new Date().toISOString()}\n`);
    await notify(`Stop requested for ${targetRepo} in ${workspacePath}`);
    return;
  }

  if (existsSync(stopFile)) unlinkSync(stopFile);
  await notify(`Starting autonomous agent for ${targetRepo} on ${targetBranch}`);
  await prepareRepository();

  let lastVerification = "";
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (existsSync(stopFile)) {
      await notify(`Stopped before iteration ${iteration} because .agent-stop exists.`);
      return;
    }

    console.log(`\n=== Iteration ${iteration}/${maxIterations} ===`);
    await runAntigravity(iteration, lastVerification);

    const verification = await verifyNextProject();
    lastVerification = verification.output.slice(-12000);

    if (verification.ok) {
      const committed = await commitAndPush(iteration);
      await notify(
        committed
          ? `Iteration ${iteration} passed checks and pushed to ${targetBranch}.`
          : `Iteration ${iteration} passed checks. No file changes to commit.`
      );
      return;
    }

    console.log(lastVerification);
    await notify(`Iteration ${iteration} failed checks. Continuing if budget remains.`);
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

  const args = [
    "--add-dir",
    workspacePath,
    "--model",
    agyModel,
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

  await run(agyCommand, args, { cwd: workspacePath });
}

async function verifyNextProject() {
  const packageJsonPath = resolve(workspacePath, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { ok: false, output: "package.json was not created." };
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const scripts = packageJson.scripts || {};
  const commands = [["npm", ["install"]]];

  for (const script of ["lint", "typecheck", "build", "test"]) {
    if (scripts[script]) commands.push(["npm", ["run", script]]);
  }

  if (!scripts.build) {
    return { ok: false, output: "package.json is missing a build script." };
  }

  let output = "";
  for (const [command, args] of commands) {
    const result = await run(command, args, { cwd: workspacePath, reject: false });
    output += `\n$ ${command} ${args.join(" ")}\n${result.output}\n`;
    if (result.code !== 0) return { ok: false, output };
  }

  return { ok: true, output };
}

async function commitAndPush(iteration) {
  const status = await run("git", ["status", "--porcelain"], { cwd: workspacePath, reject: false });
  if (!status.output.trim()) return false;

  await run("git", ["add", "-A"], { cwd: workspacePath });
  await run("git", ["commit", "-m", `agent: autonomous iteration ${iteration}`], { cwd: workspacePath });
  await run("git", ["push", "-u", "origin", targetBranch], { cwd: workspacePath, mask: [env.GITHUB_TOKEN] });
  return true;
}

async function exitsZero(command, args, cwd, mask = []) {
  const result = await run(command, args, { cwd, reject: false, mask });
  return result.code === 0;
}

function run(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const mask = options.mask || [];
  const executable = process.platform === "win32" && command === "npm" ? "npm.cmd" : command;
  const useShell = process.platform === "win32" && executable.endsWith(".cmd");

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, { cwd, shell: useShell });
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
