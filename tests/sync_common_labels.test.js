import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createOrReconcile, loadDefinition, normalizeTarget, planSync, policyLabels, run, validDispatch, validateRepository } from "../scripts/sync_common_labels.js";

const policy = `## 共通ラベル
| ラベル | 用途 |
| --- | --- |
| \`accessibility\` | アクセシビリティの改善や対応 |
| \`bug\` | 不具合に関する Issue |
| \`documentation\` | ドキュメントの追加・修正・改善 |
| \`duplicate\` | 既存の Issue と重複しているもの |
| \`enhancement\` | 機能や既存の成果物の追加・改善 |
| \`good first issue\` | 初めて参加する人が取り組みやすい Issue |
| \`help wanted\` | 追加の協力を求める Issue |
| \`invalid\` | Issue として有効な報告・提案に当たらないもの |
| \`question\` | 質問や追加確認を扱う Issue |
| \`wontfix\` | 対応しないと決定した Issue |
## 組み合わせと付与方法`;

describe("common label definition", () => {
  it("matches the canonical policy's ten names and descriptions", async () => {
    const desired = await loadDefinition(policy);
    assert.equal(desired.length, 10);
    assert.equal(policyLabels(policy).size, 10);
  });

  it("rejects description drift", async () => {
    await assert.rejects(loadDefinition(policy.replace("不具合に関する Issue", "不具合を調べる作業")), /differs from canonical policy/);
  });
});

describe("label synchronization plan", () => {
  it("creates missing labels without deleting or changing repository-specific labels", async () => {
    const desired = await loadDefinition(policy);
    const plan = planSync([{ name: "repo-only", description: "Keep", color: "123456" }], desired);
    assert.equal(plan.length, 10);
    assert.ok(plan.every(({ operation }) => operation === "create"));
  });

  it("does nothing when common labels already match and preserves extra labels", async () => {
    const desired = await loadDefinition(policy);
    assert.deepEqual(planSync([...desired, { name: "repo-only", description: "Keep", color: "123456" }], desired), []);
  });

  it("updates only a common label with drift", async () => {
    const desired = await loadDefinition(policy);
    const existing = desired.map((label) => ({ ...label }));
    existing[0].color = "000000";
    assert.deepEqual(planSync(existing, desired), [{ operation: "update", label: desired[0] }]);
  });

  it("recovers from a concurrent create without failing the sync", async () => {
    const calls = [];
    const label = (await loadDefinition(policy))[0];
    const concurrentValue = { name: label.name, description: "old", color: "000000" };
    const api = async (method, path, body) => {
      calls.push(method);
      if (method === "POST") throw Object.assign(new Error("already exists"), { status: 422 });
      if (method === "GET") return concurrentValue;
      if (method === "PATCH") return { ...body, name: body.new_name };
    };
    const result = await createOrReconcile(api, "Ateliers-Dev/repo", label);
    assert.deepEqual(calls, ["POST", "GET", "PATCH"]);
    assert.equal(result.description, label.description);
  });
});

describe("repository and dispatch guards", () => {
  it("rejects a missing repository argument instead of falling back to all repositories", async () => {
    await assert.rejects(run(["--apply", "--repository"], {}), /Missing value/);
  });

  it("accepts a single organization repository name and rejects path injection", () => {
    assert.equal(normalizeTarget("ateliers-project"), "Ateliers-Dev/ateliers-project");
    assert.throws(() => normalizeTarget("Ateliers-Dev/project/../../outside"), /one repository/);
    assert.throws(() => normalizeTarget("Other/repo"), /one repository/);
  });

  it("rejects repositories outside the organization and archived repositories", () => {
    assert.throws(() => validateRepository({ id: 1, owner: { login: "Other" } }), /outside/);
    assert.throws(() => validateRepository({ id: 1, owner: { login: "Ateliers-Dev" }, archived: true, full_name: "Ateliers-Dev/archive" }), /archived/);
    assert.throws(() => validateRepository({ id: 0, owner: { login: "Ateliers-Dev" } }), /ID/);
  });

  it("requires a valid signed repository-created dispatch", () => {
    const secret = "test-secret";
    const payload = { action: "repository-created", organization: "Ateliers-Dev", repository_id: 42, repository_full_name: "Ateliers-Dev/new-repo", delivery_id: "delivery-123" };
    const message = JSON.stringify([payload.action, payload.repository_id, payload.repository_full_name, payload.delivery_id]);
    const signature = createHmac("sha256", secret).update(message).digest("hex");
    assert.equal(validDispatch(payload, signature, secret), true);
    assert.equal(validDispatch({ ...payload, repository_id: 43 }, signature, secret), false);
    assert.equal(validDispatch(payload, signature, "wrong-secret"), false);
    assert.equal(validDispatch({ ...payload, organization: "Other" }, signature, secret), false);
  });
});
