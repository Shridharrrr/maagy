import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workspace = mkdtempSync(join(tmpdir(), "maagy-agent-"));

const env = {
  ...process.env,
  ACTION_COMMAND: "stop",
  TARGET_REPO: "owner/repo",
  WORKSPACE_PATH: workspace,
  AGENT_ALLOWED_ROOT: tmpdir()
};

const result = await run("node", ["scripts/agent-loop.mjs"], env);
if (result.code !== 0) {
  console.error(result.output);
  process.exit(result.code);
}

const stopFile = join(workspace, ".agent-stop");
console.log(readFileSync(stopFile, "utf8").trim());
console.log(`Smoke test passed: ${workspace}`);

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, shell: false });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.on("close", (code) => resolve({ code, output }));
  });
}
