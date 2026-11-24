const API = "https://api.github.com";
const USER_AGENT = "Ateliers-Dev-common-label-webhook";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function derLength(length) {
  if (length < 128) return new Uint8Array([length]);
  const bytes = [];
  for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 255);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function der(tag, contents) {
  const length = derLength(contents.length);
  const result = new Uint8Array(1 + length.length + contents.length);
  result[0] = tag;
  result.set(length, 1);
  result.set(contents, 1 + length.length);
  return result;
}

function pkcs1ToPkcs8(pkcs1) {
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const algorithm = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const privateKey = der(0x04, pkcs1);
  const contents = new Uint8Array(version.length + algorithm.length + privateKey.length);
  contents.set(version);
  contents.set(algorithm, version.length);
  contents.set(privateKey, version.length + algorithm.length);
  return der(0x30, contents);
}

function pemBytes(pem) {
  const base64 = pem.replace(/-----BEGIN RSA PRIVATE KEY-----|-----END RSA PRIVATE KEY-----|\s/g, "");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signAppJwt(env) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })));
  const claims = base64Url(new TextEncoder().encode(JSON.stringify({
    iat: now - 60,
    exp: now + 540,
    iss: env.GITHUB_APP_ID,
  })));
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs1ToPkcs8(pemBytes(env.GITHUB_APP_PRIVATE_KEY)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`;
}

const SAFE_ERROR_VALUES = {
  resource: new Set(["Installation", "Integration", "Organization", "Repository"]),
  field: new Set(["contents", "permissions", "repository_id", "repository_ids"]),
  code: new Set(["already_exists", "custom", "invalid", "missing", "unprocessable"]),
};

async function githubApiError(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const details = { status: response.status };
  const requestId = response.headers.get("x-github-request-id");
  if (requestId && /^[A-Za-z0-9:.-]{1,100}$/.test(requestId)) details.requestId = requestId;

  const allowedMessages = new Set([
    "Bad credentials",
    "Not Found",
    "Resource not accessible by integration",
    "Server Error",
    "Validation Failed",
  ]);
  if (allowedMessages.has(body?.message)) details.message = body.message;

  if (Array.isArray(body?.errors)) {
    details.errors = body.errors.slice(0, 10)
      .map((item) => {
        const error = {};
        for (const field of ["resource", "field", "code"]) {
          const value = item?.[field];
          if (SAFE_ERROR_VALUES[field].has(value)) error[field] = value;
        }
        return error;
      })
      .filter((error) => Object.keys(error).length > 0);
  }

  return details;
}

export async function githubApiRequest(url, init) {
  const headers = new Headers(init.headers);
  headers.set("user-agent", USER_AGENT);
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const details = await githubApiError(response);
    const error = new Error(`GitHub API request failed (${response.status})`);
    error.diagnostics = details;
    throw error;
  }
  return response;
}

async function installationToken(env, appJwt, repositoryId) {
  const response = await githubApiRequest(`${API}/app/installations/${env.GITHUB_APP_INSTALLATION_ID}/access_tokens`, {
    method: "POST",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${appJwt}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify({
      repository_ids: [Number(repositoryId)],
      permissions: { contents: "write" },
    }),
  });
  return (await response.json()).token;
}

async function validSignature(rawBody, signature, secret) {
  if (!/^sha256=[0-9a-f]{64}$/i.test(signature || "") || !secret) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, rawBody));
  const expected = `sha256=${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  const actualBytes = new TextEncoder().encode(signature.toLowerCase());
  const expectedBytes = new TextEncoder().encode(expected);
  let difference = actualBytes.length ^ expectedBytes.length;
  for (let index = 0; index < Math.min(actualBytes.length, expectedBytes.length); index++) difference |= actualBytes[index] ^ expectedBytes[index];
  return difference === 0;
}

export function validateRepositoryEvent(payload, organization) {
  const repository = payload?.repository;
  const owner = repository?.owner?.login;
  const name = repository?.name;
  return payload?.action === "created" &&
    payload?.organization?.login === organization &&
    owner === organization &&
    typeof name === "string" &&
    repository?.full_name?.toLowerCase() === `${organization}/${name}`.toLowerCase() &&
    Number.isSafeInteger(repository?.id) &&
    repository.id > 0 &&
    repository.archived !== true;
}

export async function signDispatch(payload, secret) {
  const data = JSON.stringify(["repository-created", payload.repository.id, payload.repository.full_name, payload.delivery_id]);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    if (request.method === "GET" && new URL(request.url).pathname === "/health") return json({ status: "ok" });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/github/webhook") return json({ error: "not found" }, 404);
    if (Number(request.headers.get("content-length") || 0) > 1_000_000) return json({ error: "payload too large" }, 413);

    const rawBody = await request.arrayBuffer();
    if (rawBody.byteLength > 1_000_000) return json({ error: "payload too large" }, 413);
    if (!(await validSignature(rawBody, request.headers.get("x-hub-signature-256"), env.GITHUB_WEBHOOK_SECRET))) {
      return json({ error: "invalid signature" }, 401);
    }
    if (request.headers.get("x-github-event") !== "repository") return json({ status: "ignored" });
    const deliveryId = request.headers.get("x-github-delivery");
    if (!deliveryId || deliveryId.length > 100) return json({ error: "invalid delivery id" }, 400);

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }
    if (payload.action !== "created") return json({ status: "ignored" });

    if (!validateRepositoryEvent(payload, env.GITHUB_ORGANIZATION)) {
      return json({ error: "repository is outside the configured organization or is invalid" }, 403);
    }
    const repository = payload.repository;

    let operation = "app-authentication";
    try {
      const appJwt = await signAppJwt(env);
      operation = "installation-token";
      const token = await installationToken(env, appJwt, env.DISPATCH_REPOSITORY_ID);
      operation = "repository-dispatch";
      const response = await githubApiRequest(`${API}/repos/${env.GITHUB_ORGANIZATION}/${env.DISPATCH_REPOSITORY_NAME}/dispatches`, {
        method: "POST",
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({
          event_type: "repository-created",
          client_payload: {
            repository_id: repository.id,
            repository_full_name: repository.full_name,
            delivery_id: deliveryId,
            dispatch_signature: await signDispatch({
              repository,
              delivery_id: deliveryId,
            }, env.COMMON_LABEL_DISPATCH_SECRET),
          },
        }),
      });
      if (response.status !== 204) throw new Error(`GitHub rejected dispatch (${response.status})`);
      return json({ status: "dispatched" }, 202);
    } catch (error) {
      console.error("repository dispatch failed", JSON.stringify({
        deliveryId,
        operation,
        diagnostics: error?.diagnostics ?? { errorType: error instanceof Error ? error.name : "unknown" },
      }));
      // Do not return exception details: they can contain request context.
      return json({ error: "dispatch failed; inspect the Worker logs" }, 502);
    }
  },
};

