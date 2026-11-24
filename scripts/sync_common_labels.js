import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const ORGANIZATION = "Ateliers-Dev";
export const POLICY_URL = "https://raw.githubusercontent.com/Ateliers-Dev/ateliers-website/main/docs/development-guidelines/technical-policies/issue-classification-and-label-policy.md";
const API = "https://api.github.com";
const DEFINITION_PATH = fileURLToPath(new URL("../labels.json", import.meta.url));

export function policyLabels(markdown) {
  const heading = "## 共通ラベル";
  const start = markdown.indexOf(heading);
  if (start < 0) throw new Error("Canonical policy has no '共通ラベル' section");
  const section = markdown.slice(start + heading.length).split("\n## ", 1)[0];
  const result = new Map();
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*(.*?)\s*\|\s*$/);
    if (!match) continue;
    if (result.has(match[1])) throw new Error(`Duplicate label in canonical policy: ${match[1]}`);
    result.set(match[1], match[2]);
  }
  if (result.size === 0) throw new Error("Canonical policy has no machine-readable label rows");
  return result;
}

export async function loadDefinition(policyText) {
  const definition = JSON.parse(await readFile(DEFINITION_PATH, "utf8"));
  if (definition.organization !== ORGANIZATION) throw new Error("Label definition organization does not match the configured organization");
  if (!Array.isArray(definition.labels) || definition.labels.length !== 10) throw new Error("Label definition must contain exactly the ten standard labels");
  const source = policyLabels(policyText);
  const names = new Set();
  for (const label of definition.labels) {
    if (!label || Object.keys(label).sort().join(",") !== "color,description,name") throw new Error("Each label must contain only name, description, and color");
    if (typeof label.name !== "string" || typeof label.description !== "string" || names.has(label.name)) throw new Error(`Invalid or duplicate label definition: ${label.name}`);
    if (!/^[0-9a-fA-F]{6}$/.test(label.color)) throw new Error(`Invalid hex color for ${label.name}`);
    names.add(label.name);
  }
  if (names.size !== source.size || [...names].some((name) => !source.has(name))) throw new Error("Label names differ from canonical policy");
  for (const label of definition.labels) {
    if (label.description !== source.get(label.name)) throw new Error(`Description for ${label.name} differs from canonical policy`);
  }
  return definition.labels;
}

export function planSync(existing, desired) {
  const byName = new Map(existing.map((label) => [label.name.toLocaleLowerCase("en-US"), label]));
  const operations = [];
  for (const expected of desired) {
    const current = byName.get(expected.name.toLocaleLowerCase("en-US"));
    if (!current) operations.push({ operation: "create", label: expected });
    else if (["name", "description", "color"].some((field) => current[field] !== expected[field])) operations.push({ operation: "update", label: expected });
  }
  return operations;
}

export function validateRepository(repository, expectedFullName = undefined) {
  if (!repository || repository.owner?.login?.toLocaleLowerCase("en-US") !== ORGANIZATION.toLocaleLowerCase("en-US")) throw new Error(`Refusing repository outside ${ORGANIZATION}`);
  if (!Number.isSafeInteger(repository.id) || repository.id < 1) throw new Error("Repository ID is invalid");
  if (repository.archived) throw new Error(`Refusing to modify archived repository ${repository.full_name}`);
  if (expectedFullName && repository.full_name?.toLocaleLowerCase("en-US") !== expectedFullName.toLocaleLowerCase("en-US")) throw new Error("Repository full name does not match the requested target");
}

export function normalizeTarget(target) {
  if (!target) return undefined;
  const fullName = target.includes("/") ? target : `${ORGANIZATION}/${target}`;
  if (!new RegExp(`^${ORGANIZATION}/[A-Za-z0-9._-]+$`, "i").test(fullName)) throw new Error(`Target repository must be one repository owned by ${ORGANIZATION}`);
  return fullName;
}

export function validDispatch(payload, signature, secret) {
  if (!secret || payload?.action !== "repository-created" || !Number.isSafeInteger(payload.repository_id) || payload.repository_id < 1) return false;
  if (payload.organization !== ORGANIZATION || typeof payload.repository_full_name !== "string" || !payload.repository_full_name.startsWith(`${ORGANIZATION}/`) || typeof payload.delivery_id !== "string") return false;
  if (!/^[0-9a-f]{64}$/.test(signature || "")) return false;
  const message = JSON.stringify([payload.action, payload.repository_id, payload.repository_full_name, payload.delivery_id]);
  const expected = createHmac("sha256", secret).update(message).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function fetchCanonicalPolicy(fetchImpl = fetch, sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(POLICY_URL);
    if (response.ok) return response.text();
    if (response.status !== 503 || attempt === maxAttempts) {
      throw new Error(`Could not read canonical policy (HTTP ${response.status})`);
    }
    await sleep(250 * 2 ** (attempt - 1));
  }
  throw new Error("Could not read canonical policy after retries");
}

async function request(token, method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
      "user-agent": "Ateliers-Dev-common-label-sync",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = new Error(`GitHub API request failed (${method} ${path}: HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

async function repositories(token, target, targetId) {
  if (targetId !== undefined) {
    const repository = await request(token, "GET", `/repositories/${targetId}`);
    validateRepository(repository, target);
    return [repository];
  }
  if (target) {
    const fullName = normalizeTarget(target);
    const repository = await request(token, "GET", `/repos/${fullName}`);
    validateRepository(repository, fullName);
    return [repository];
  }
  const found = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(token, "GET", `/orgs/${ORGANIZATION}/repos?type=all&per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error("GitHub returned an unexpected organization repository list");
    found.push(...batch);
    if (batch.length < 100) break;
  }
  return found.filter((repository) => !repository.archived);
}

async function listLabels(token, fullName) {
  const labels = [];
  for (let page = 1; ; page += 1) {
    const batch = await request(token, "GET", `/repos/${fullName}/labels?per_page=100&page=${page}`);
    if (!Array.isArray(batch)) throw new Error(`GitHub returned an unexpected label list for ${fullName}`);
    labels.push(...batch);
    if (batch.length < 100) return labels;
  }
}

export async function createOrReconcile(apiRequest, fullName, label) {
  const path = `/repos/${fullName}/labels`;
  try {
    return await apiRequest("POST", path, label);
  } catch (error) {
    if (error.status !== 422) throw error;
  }

  const labelPath = `${path}/${encodeURIComponent(label.name)}`;
  let existing;
  try {
    existing = await apiRequest("GET", labelPath);
  } catch (error) {
    if (error.status === 404) throw new Error(`Label create conflicted but ${label.name} was not found`);
    throw error;
  }
  if (["name", "description", "color"].every((field) => existing[field] === label[field])) return existing;
  return apiRequest("PATCH", labelPath, {
    new_name: label.name,
    description: label.description,
    color: label.color,
  });
}

async function apply(token, fullName, operation, label) {
  const path = `/repos/${fullName}/labels`;
  if (operation === "create") return createOrReconcile((method, apiPath, body) => request(token, method, apiPath, body), fullName, label);
  return request(token, "PATCH", `${path}/${encodeURIComponent(label.name)}`, {
    new_name: label.name, description: label.description, color: label.color,
  });
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--dry-run") options.apply = false;
    else if (["--repository", "--repository-id", "--dispatch-signature"].includes(argument)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw new Error(`Missing value for ${argument}`);
      options[argument.slice(2)] = value;
      index += 1;
    }
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options["repository-id"] !== undefined) {
    const id = Number(options["repository-id"]);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("Repository ID must be a positive integer");
    options.repositoryId = id;
  }
  return options;
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const target = normalizeTarget(options.repository);
  options.repository = target;
  const token = env.GITHUB_TOKEN;
  if (!token) throw new Error("A GitHub App installation token is required");
  if (options.repositoryId !== undefined) {
    const signedPayload = {
      action: "repository-created",
      organization: ORGANIZATION,
      repository_id: options.repositoryId,
      repository_full_name: target,
      delivery_id: env.DISPATCH_DELIVERY_ID,
    };
    if (!validDispatch(signedPayload, options["dispatch-signature"], env.COMMON_LABEL_DISPATCH_SECRET)) throw new Error("Repository dispatch signature is invalid");
  }
  const desired = await loadDefinition(await fetchCanonicalPolicy());
  const targets = await repositories(token, target, options.repositoryId);
  let failures = 0;
  for (const repository of targets) {
    validateRepository(repository, target);
    const plan = planSync(await listLabels(token, repository.full_name), desired);
    if (!plan.length) {
      console.log(`${repository.full_name}: already synchronized`);
      continue;
    }
    for (const { operation, label } of plan) {
      console.log(`${repository.full_name}: ${options.apply ? "" : "would "}${operation} ${label.name}`);
      if (!options.apply) continue;
      try {
        await apply(token, repository.full_name, operation, label);
      } catch (error) {
        console.error(`${repository.full_name}: ${error.message}`);
        failures += 1;
        break;
      }
    }
  }
  console.log(`Repositories checked: ${targets.length}; mode: ${options.apply ? "apply" : "dry-run"}`);
  if (failures) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 2;
  });
}

