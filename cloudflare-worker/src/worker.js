export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let chatId = null;

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return text("maagy telegram agent is running");
      }

      if (request.method !== "POST" || url.pathname !== "/telegram") {
        return text("not found", 404);
      }

      const update = await request.json();
      const message = update.message || update.edited_message;
      if (!message?.text) return json({ ok: true });

      chatId = message.chat.id;
      const userId = String(message.from?.id || "");
      if (userId !== String(env.TELEGRAM_ALLOWED_USER_ID)) {
        await sendTelegram(env, chatId, "Unauthorized user.");
        return json({ ok: true });
      }

      const textValue = message.text.trim();
      if (textValue === "/help" || textValue === "/start") {
        await sendTelegram(env, chatId, helpText());
        return json({ ok: true });
      }

      if (textValue.startsWith("/status")) {
        const runs = await getWorkflowStatus(env);
        await sendTelegram(env, chatId, runs);
        return json({ ok: true });
      }

      if (textValue.startsWith("/models")) {
        await dispatchWorkflow(env, withDefaults(env, chatId, { command: "models", prompt: "List Antigravity models" }));
        await sendTelegram(env, chatId, "Model list requested from your self-hosted runner.");
        return json({ ok: true });
      }

      if (textValue.startsWith("/quota")) {
        await dispatchWorkflow(env, withDefaults(env, chatId, { command: "quota", prompt: "Check Antigravity quota" }));
        await sendTelegram(env, chatId, "Quota probe requested. Antigravity CLI may not expose exact usage.");
        return json({ ok: true });
      }

      if (textValue.startsWith("/stop")) {
        const parts = parsePipeCommand(textValue.replace("/stop", "").trim());
        await dispatchWorkflow(env, withDefaults(env, chatId, {
          command: "stop",
          target_repo: parts[0] || env.DEFAULT_TARGET_REPO,
          workspace_path: parts[1] || env.DEFAULT_WORKSPACE_PATH,
          prompt: "Stop requested from Telegram"
        }));
        await sendTelegram(env, chatId, "Stop signal dispatched.");
        return json({ ok: true });
      }

      if (textValue.startsWith("/build")) {
        const parts = parsePipeCommand(textValue.replace("/build", "").trim());
        const options = parseOptions(parts.slice(3));
        const targetRepo = parts[0] || env.DEFAULT_TARGET_REPO;
        const workspacePath = parts.length >= 3 ? parts[1] : env.DEFAULT_WORKSPACE_PATH;
        const prompt = parts.length >= 3 ? parts[2] : parts[1] || "";

        if (!targetRepo || !workspacePath || !prompt) {
          await sendTelegram(env, chatId, helpText());
          return json({ ok: true });
        }

        await dispatchWorkflow(env, withDefaults(env, chatId, {
          command: "start",
          target_repo: targetRepo,
          workspace_path: workspacePath,
          prompt,
          max_iterations: clampIterations(options.iterations || options.max_iterations || "5"),
          branch: options.branch || "agent-main",
          agy_model: options.model || env.DEFAULT_AGY_MODEL || "Gemini 3.1 Pro (High)"
        }));

        await sendTelegram(env, chatId, `Started ${options.branch || "agent-main"} run for ${targetRepo} with ${options.model || env.DEFAULT_AGY_MODEL || "Gemini 3.1 Pro (High)"}.`);
        return json({ ok: true });
      }

      await sendTelegram(env, chatId, helpText());
      return json({ ok: true });
    } catch (error) {
      if (chatId) {
        await sendTelegram(env, chatId, `Command failed: ${error.message}`);
      }
      return json({ ok: false, error: error.message }, 500);
    }
  }
};

function parsePipeCommand(value) {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseOptions(parts) {
  const options = {};
  for (const part of parts) {
    const match = part.match(/^([\w-]+)\s*=\s*(.+)$/);
    if (match) options[match[1].toLowerCase()] = match[2].trim();
  }
  return options;
}

function clampIterations(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return "5";
  return String(Math.max(1, Math.min(parsed, 5)));
}

function withDefaults(env, chatId, inputs) {
  return {
    target_repo: inputs.target_repo || env.DEFAULT_TARGET_REPO,
    workspace_path: inputs.workspace_path || env.DEFAULT_WORKSPACE_PATH,
    prompt: inputs.prompt || "",
    max_iterations: inputs.max_iterations || "5",
    branch: inputs.branch || "agent-main",
    agy_model: inputs.agy_model || env.DEFAULT_AGY_MODEL || "Gemini 3.1 Pro (High)",
    telegram_chat_id: String(chatId),
    ...inputs
  };
}

async function dispatchWorkflow(env, inputs) {
  const owner = required(env, "GITHUB_OWNER");
  const repo = required(env, "GITHUB_REPO");
  const workflow = env.GITHUB_WORKFLOW_FILE || "autonomous-agent.yml";
  const endpoint = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${required(env, "GITHUB_TOKEN")}`,
      "content-type": "application/json",
      "user-agent": "maagy-telegram-agent"
    },
    body: JSON.stringify({ ref: env.GITHUB_REF || "main", inputs })
  });

  if (!response.ok) {
    throw new Error(`GitHub dispatch failed: ${response.status} ${await response.text()}`);
  }
}

async function getWorkflowStatus(env) {
  const owner = required(env, "GITHUB_OWNER");
  const repo = required(env, "GITHUB_REPO");
  const workflow = env.GITHUB_WORKFLOW_FILE || "autonomous-agent.yml";
  const endpoint = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/runs?per_page=3`;
  const response = await fetch(endpoint, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${required(env, "GITHUB_TOKEN")}`,
      "user-agent": "maagy-telegram-agent"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub status failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  if (!data.workflow_runs?.length) return "No workflow runs found yet.";

  return data.workflow_runs
    .map((run) => {
      const state = run.status === "completed" ? run.conclusion : run.status;
      return [
        `#${run.run_number}: ${state}`,
        `branch: ${run.head_branch}`,
        `started: ${run.created_at}`,
        run.html_url
      ].join("\n");
    })
    .join("\n\n");
}

async function sendTelegram(env, chatId, textValue) {
  await fetch(`https://api.telegram.org/bot${required(env, "TELEGRAM_BOT_TOKEN")}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: textValue.slice(0, 3900) })
  });
}

function helpText() {
  return [
    "Commands:",
    "/build owner/repo | C:\\path\\to\\empty-folder | prompt",
    "/build owner/repo | prompt",
    "/build owner/repo | C:\\path | prompt | model=Gemini 3.5 Flash (High) | iterations=3 | branch=agent-main",
    "/stop owner/repo | C:\\path\\to\\folder",
    "/status",
    "/models",
    "/quota",
    "",
    "The agent pushes direct commits to agent-main and stops after checks pass or 5 iterations."
  ].join("\n");
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function text(body, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
