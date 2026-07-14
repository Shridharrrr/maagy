export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return text("maagy telegram agent is running");
    }

    if (request.method !== "POST" || url.pathname !== "/telegram") {
      return text("not found", 404);
    }

    const update = await request.json();
    const message = update.message || update.edited_message;
    if (!message?.text) return json({ ok: true });

    const chatId = message.chat.id;
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

    if (textValue.startsWith("/stop")) {
      const parts = parsePipeCommand(textValue.replace("/stop", "").trim());
      await dispatchWorkflow(env, {
        command: "stop",
        target_repo: parts[0] || env.DEFAULT_TARGET_REPO,
        workspace_path: parts[1] || env.DEFAULT_WORKSPACE_PATH,
        prompt: "Stop requested from Telegram",
        max_iterations: "5",
        branch: "agent-main"
      });
      await sendTelegram(env, chatId, "Stop signal dispatched.");
      return json({ ok: true });
    }

    if (textValue.startsWith("/build")) {
      const parts = parsePipeCommand(textValue.replace("/build", "").trim());
      const targetRepo = parts[0] || env.DEFAULT_TARGET_REPO;
      const workspacePath = parts.length >= 3 ? parts[1] : env.DEFAULT_WORKSPACE_PATH;
      const prompt = parts.length >= 3 ? parts[2] : parts[1] || "";

      if (!targetRepo || !workspacePath || !prompt) {
        await sendTelegram(env, chatId, helpText());
        return json({ ok: true });
      }

      await dispatchWorkflow(env, {
        command: "start",
        target_repo: targetRepo,
        workspace_path: workspacePath,
        prompt,
        max_iterations: "5",
        branch: "agent-main",
        agy_model: env.DEFAULT_AGY_MODEL || "Gemini 3.1 Pro (High)"
      });

      await sendTelegram(env, chatId, `Started agent-main run for ${targetRepo}.`);
      return json({ ok: true });
    }

    await sendTelegram(env, chatId, helpText());
    return json({ ok: true });
  }
};

function parsePipeCommand(value) {
  return value
    .split("|")
    .map((part) => part.trim())
    .filter(Boolean);
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
    "/stop owner/repo | C:\\path\\to\\folder",
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
