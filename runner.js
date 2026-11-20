const path = require("path");

const MAX_RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;

async function bootstrap() {
  const secrets = JSON.parse(process.env.ALL_SECRETS || "{}");
  const gatewayUrl = String(secrets.CLOUDFLARE_GATEWAY_URL || "").replace(/\/+$/, "");
  const gatewayKey = String(secrets.GATEWAY_SECRET_KEY || "");
  const gistId = String(secrets.STATE_GIST_ID || "");
  const gistToken = String(secrets.STATE_GIST_TOKEN || "");

  if (!gatewayUrl || !gatewayKey) {
    throw new Error("Missing CLOUDFLARE_GATEWAY_URL or GATEWAY_SECRET_KEY in repository secrets.");
  }
  if (!gistId || !gistToken) {
    throw new Error("Missing STATE_GIST_ID or STATE_GIST_TOKEN in repository secrets.");
  }

  const fullRepo = process.env.GITHUB_REPOSITORY || "owner/unknown-project";
  const projectId = fullRepo.split("/")[1] || "unknown-project";
  const stateFileName = `${projectId}-state.json`;

  const gateway = createGatewayClient(gatewayUrl, gatewayKey);
  const stateStore = await loadRemoteState(gateway, gistId, gistToken, stateFileName);

  const context = {
    projectId: projectId,
    secrets: secrets,
    gateway: gateway,
    state: {
      get: (namespace, key) => getStateValue(stateStore, namespace, key),
      set: (namespace, key, value) => setStateValue(stateStore, namespace, key, value)
    },
    sleep: sleep
  };

  const projectEntryPath = path.resolve(process.cwd(), "project", "project.js");
  const projectModule = require(projectEntryPath);
  const runProject = typeof projectModule === "function" ? projectModule : projectModule.main;

  if (typeof runProject !== "function") {
    throw new Error("project.js must export a function or a main() method.");
  }

  await runProject(context);

  if (stateStore.dirty) {
    await saveRemoteState(gateway, gistId, gistToken, stateFileName, stateStore.data);
  }
}

function createGatewayClient(gatewayUrl, gatewayKey) {
  async function request(servicePath, options = {}) {
    const normalizedPath = servicePath.startsWith("/") ? servicePath : `/${servicePath}`;
    const url = `${gatewayUrl}${normalizedPath}`;
    const headers = {
      "X-Gateway-Key": gatewayKey,
      ...(options.headers || {})
    };

    for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await fetch(url, {
          method: options.method || "GET",
          headers: headers,
          body: options.body
        });

        if (response.ok) {
          return response;
        }

        if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRY_ATTEMPTS) {
          await sleep(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }

        throw new Error(`Gateway HTTP ${response.status} on ${normalizedPath}: ${await response.text()}`);
      } catch (error) {
        if (attempt >= MAX_RETRY_ATTEMPTS) throw error;
        await sleep(RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }

  async function getJson(servicePath, headers = {}) {
    const response = await request(servicePath, {
      method: "GET",
      headers: headers
    });
    return response.json();
  }

  async function postJson(servicePath, payload, headers = {}) {
    const response = await request(servicePath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...headers
      },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }

  return {
    fetch: request,
    getJson: getJson,
    postJson: postJson
  };
}

async function loadRemoteState(gateway, gistId, gistToken, stateFileName) {
  const gist = await gateway.getJson(`/github/gists/${gistId}`, {
    "Authorization": `Bearer ${gistToken}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "Automation-Core/1.0",
    "X-GitHub-Api-Version": "2022-11-28"
  });

  const rawContent = gist?.files?.[stateFileName]?.content;
  if (!rawContent) {
    return { data: {}, dirty: false };
  }

  try {
    return { data: JSON.parse(rawContent), dirty: false };
  } catch (e) {
    return { data: {}, dirty: true };
  }
}

async function saveRemoteState(gateway, gistId, gistToken, stateFileName, stateData) {
  await gateway.fetch(`/github/gists/${gistId}`, {
    method: "PATCH",
    headers: {
      "Authorization": `Bearer ${gistToken}`,
      "Accept": "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "Automation-Core/1.0",
      "X-GitHub-Api-Version": "2022-11-28"
    },
    body: JSON.stringify({
      files: {
        [stateFileName]: {
          content: JSON.stringify(stateData, null, 2)
        }
      }
    })
  });
}

function getStateValue(stateStore, namespace, key) {
  const compositeKey = `${namespace}_${key}`;
  return stateStore.data[compositeKey] || "";
}

function setStateValue(stateStore, namespace, key, value) {
  const compositeKey = `${namespace}_${key}`;
  const normalizedValue = String(value);
  if (stateStore.data[compositeKey] !== normalizedValue) {
    stateStore.data[compositeKey] = normalizedValue;
    stateStore.dirty = true;
  }
  return normalizedValue;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

bootstrap().catch(error => {
  console.error(`Execution failed: ${error.message}`);
  process.exit(1);
});
