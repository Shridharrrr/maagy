export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let chatId = null;

    try {
      if (request.method === "GET" && url.pathname === "/") {
        return text("maagy telegram agent is running");
      }

      if (request.method === "POST" && url.pathname === "/status-update") {
        return handleStatusUpdate(request, env);
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
        await sendTelegram(env, chatId, await getStatus(env));
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
        const targetRepo = parts[0] || env.DEFAULT_TARGET_REPO;
        const workspacePath = workspaceFromTail(env, parts[1]);

        if (!targetRepo || !workspacePath) {
          await sendTelegram(env, chatId, helpText());
          return json({ ok: true });
        }

        await dispatchWorkflow(env, withDefaults(env, chatId, {
          command: "stop",
          target_repo: targetRepo,
          workspace_path: workspacePath,
          prompt: "Stop requested from Telegram"
        }));
        await sendTelegram(env, chatId, "Stop signal dispatched.");
        return json({ ok: true });
      }

      if (textValue.startsWith("/build")) {
        const parts = parsePipeCommand(textValue.replace("/build", "").trim());
        const options = parseOptions(parts.slice(3));
        const targetRepo = parts[0] || env.DEFAULT_TARGET_REPO;
        const workspacePath = workspaceFromTail(env, parts[1]);
        const prompt = parts[2] || "";

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
          agy_model: options.model || env.DEFAULT_AGY_MODEL || "Gemini 3.1 Pro (High)",
          agy_fallback_models: options.fallback || env.DEFAULT_AGY_FALLBACK_MODELS || "Gemini 3.5 Flash (High),Gemini 3.5 Flash (Medium),Gemini 3.5 Flash (Low)"
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
    agy_fallback_models: inputs.agy_fallback_models || env.DEFAULT_AGY_FALLBACK_MODELS || "Gemini 3.5 Flash (High),Gemini 3.5 Flash (Medium),Gemini 3.5 Flash (Low)",
    telegram_chat_id: String(chatId),
    ...inputs
  };
}

function workspaceFromTail(env, tail) {
  if (!env.DEFAULT_WORKSPACE_ROOT || !tail) return "";
  if (/^[a-zA-Z]:[\\/]/.test(tail) || tail.includes("/") || tail.includes("\\") || tail.includes("..")) {
    return "";
  }

  const safeTail = tail.replace(/[^\w.-]/g, "-");
  return `${env.DEFAULT_WORKSPACE_ROOT}\\${safeTail}`;
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

async function getStatus(env) {
  if (env.STATUS_KV) {
    const stored = await env.STATUS_KV.get("latest", "json");
    if (stored) return formatStoredStatus(stored);
  }

  return getWorkflowStatus(env);
}

async function handleStatusUpdate(request, env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!env.STATUS_UPDATE_TOKEN || token !== env.STATUS_UPDATE_TOKEN) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const status = await request.json();
  status.updated_at = new Date().toISOString();

  if (env.STATUS_KV) {
    await env.STATUS_KV.put("latest", JSON.stringify(status), { expirationTtl: 60 * 60 * 24 * 7 });
    if (status.run_id) {
      await env.STATUS_KV.put(`run:${status.run_id}`, JSON.stringify(status), { expirationTtl: 60 * 60 * 24 * 7 });
    }
  }

  return json({ ok: true });
}

function formatStoredStatus(status) {
  const lines = [
    `state: ${status.state || "unknown"}`,
    `repo: ${status.repo || "unknown"}`,
    `branch: ${status.branch || "unknown"}`,
    `model: ${status.model || "unknown"}`,
    `iteration: ${status.iteration || 0}/${status.max_iterations || 0}`,
    `step: ${status.step || "unknown"}`,
    `last verification: ${status.last_verification || "none"}`,
    `updated: ${status.updated_at || "unknown"}`
  ];

  if (status.workspace) lines.push(`workspace: ${status.workspace}`);
  if (status.workflow_url) lines.push(status.workflow_url);
  return lines.join("\n");
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
    "/build owner/repo | workspace-name | prompt",
    "/build owner/repo | workspace-name | prompt | model=Gemini 3.5 Flash (High) | fallback=Gemini 3.5 Flash (Medium),Gemini 3.5 Flash (Low) | iterations=3 | branch=agent-main",
    "/stop owner/repo | workspace-name",
    "/status",
    "/models",
    "/quota",
    "",
    "workspace-name is created under DEFAULT_WORKSPACE_ROOT.",
    "The agent sends progress updates while it prepares, runs Antigravity, verifies, commits, and pushes.",
    "Successful frontend builds send a homepage screenshot when Playwright capture is available.",
    "It pushes direct commits to agent-main and stops after checks pass or 5 iterations."
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
