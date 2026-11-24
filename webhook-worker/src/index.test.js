import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { githubApiRequest, signDispatch, signIssueDispatch, validateIssueEvent, validateRepositoryEvent } from "./index.js";
import { validDispatch } from "../../scripts/sync_common_labels.js";

const valid = {
  action: "created",
  organization: { login: "Ateliers-Dev" },
  repository: {
    id: 123,
    name: "new-project",
    full_name: "Ateliers-Dev/new-project",
    owner: { login: "Ateliers-Dev" },
    archived: false,
  },
};

describe("validateRepositoryEvent", () => {
  it("accepts a new repository owned by the configured organization", () => {
    assert.equal(validateRepositoryEvent(valid, "Ateliers-Dev"), true);
  });

  it("rejects other organizations even when the payload is otherwise valid", () => {
    assert.equal(validateRepositoryEvent(valid, "Other-Org"), false);
  });

  it("rejects a mismatched canonical repository name", () => {
    assert.equal(validateRepositoryEvent({ ...valid, repository: { ...valid.repository, full_name: "Ateliers-Dev/other" } }, "Ateliers-Dev"), false);
  });

  it("rejects non-created, archived, or invalid-ID events", () => {
    assert.equal(validateRepositoryEvent({ ...valid, action: "deleted" }, "Ateliers-Dev"), false);
    assert.equal(validateRepositoryEvent({ ...valid, repository: { ...valid.repository, archived: true } }, "Ateliers-Dev"), false);
    assert.equal(validateRepositoryEvent({ ...valid, repository: { ...valid.repository, id: 0 } }, "Ateliers-Dev"), false);
  });

  it("signs the dispatch fields consumed by the workflow guard", async () => {
    const secret = "test-secret";
    const repository = valid.repository;
    const deliveryId = "delivery-123";
    const signature = await signDispatch({ repository, delivery_id: deliveryId }, secret);
    assert.equal(validDispatch({
      action: "repository-created",
      organization: "Ateliers-Dev",
      repository_id: repository.id,
      repository_full_name: repository.full_name,
      delivery_id: deliveryId,
    }, signature, secret), true);
  });
});

describe("validateIssueEvent", () => {
  const payload = {
    action: "opened",
    organization: { login: "Ateliers-Dev" },
    repository: { id: 124, name: "new-project", full_name: "Ateliers-Dev/new-project", owner: { login: "Ateliers-Dev" } },
    issue: { id: 456, node_id: "I_kwDO-test", number: 7, html_url: "https://github.com/Ateliers-Dev/new-project/issues/7" },
  };

  it("accepts a well-formed issue opened in an organization repository", () => {
    assert.equal(validateIssueEvent(payload, "Ateliers-Dev"), true);
  });

  it("rejects pull requests, other organizations, mismatched URLs, and non-opened actions", () => {
    assert.equal(validateIssueEvent({ ...payload, issue: { ...payload.issue, pull_request: { url: "https://api.github.com/pulls/7" } } }, "Ateliers-Dev"), false);
    assert.equal(validateIssueEvent(payload, "Other-Org"), false);
    assert.equal(validateIssueEvent({ ...payload, repository: { ...payload.repository, archived: true } }, "Ateliers-Dev"), false);
    assert.equal(validateIssueEvent({ ...payload, issue: { ...payload.issue, html_url: "https://github.com/Ateliers-Dev/other/issues/7" } }, "Ateliers-Dev"), false);
    assert.equal(validateIssueEvent({ ...payload, action: "reopened" }, "Ateliers-Dev"), false);
  });

  it("signs the event identity passed to the task-management workflow", async () => {
    const secret = "test-secret";
    const deliveryId = "issue-delivery-1";
    const signature = await signIssueDispatch({ organization: "Ateliers-Dev", repository: payload.repository, issue: payload.issue, delivery_id: deliveryId }, secret);
    assert.match(signature, /^[0-9a-f]{64}$/);
    const { createHmac } = await import("node:crypto");
    assert.equal(signature, createHmac("sha256", secret).update(JSON.stringify(["issue-opened", "Ateliers-Dev", 124, "Ateliers-Dev/new-project", 456, 7, deliveryId])).digest("hex"));
  });
});

describe("GitHub API request diagnostics", () => {
  it("sets an explicit User-Agent and keeps only allowlisted error fields", async (t) => {
    const secret = "private-token-value";
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      assert.equal(new Headers(init.headers).get("user-agent"), "Ateliers-Dev-common-label-webhook");
      return new Response(JSON.stringify({
        message: "Resource not accessible by integration",
        token: secret,
        payload: { dispatch_signature: "sensitive-signature" },
        errors: [
          { resource: "Integration", field: "repository_ids", code: "invalid", message: secret },
          { resource: secret, field: secret, code: secret },
        ],
      }), {
        status: 403,
        headers: { "x-github-request-id": "ABCD:1234" },
      });
    });

    await assert.rejects(githubApiRequest("https://api.github.com/test", { method: "POST", headers: { accept: "application/vnd.github+json" } }), (error) => {
      assert.deepEqual(error.diagnostics, {
        status: 403,
        requestId: "ABCD:1234",
        message: "Resource not accessible by integration",
        errors: [{ resource: "Integration", field: "repository_ids", code: "invalid" }],
      });
      assert.equal(JSON.stringify(error.diagnostics).includes(secret), false);
      assert.equal(JSON.stringify(error.diagnostics).includes("sensitive-signature"), false);
      return true;
    });
  });
});


