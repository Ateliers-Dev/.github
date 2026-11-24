import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validIssueDispatch, validIssueIdentity, validRepositoryIdentity } from "../scripts/task_management_guards.js";
import { signIssueDispatch, validateIssueEvent } from "../webhook-worker/src/index.js";

const repository = { id: 124, full_name: "Ateliers-Dev/new-project", owner: { login: "Ateliers-Dev" }, archived: false };
const issue = { id: 456, node_id: "I_kwDO-test", number: 7 };

describe("task-management input guards", () => {
  it("accepts only the signed organization repository identity", () => {
    assert.equal(validRepositoryIdentity(repository, 124, "Ateliers-Dev/new-project"), true);
    assert.equal(validRepositoryIdentity({ ...repository, id: 125 }, 124, repository.full_name), false);
    assert.equal(validRepositoryIdentity({ ...repository, owner: { login: "other-org" } }, 124, repository.full_name), false);
    assert.equal(validRepositoryIdentity({ ...repository, archived: true }, 124, repository.full_name), false);
  });

  it("rejects pull requests and mismatched issue identities", () => {
    assert.equal(validIssueIdentity(issue, 456, "I_kwDO-test", 7), true);
    assert.equal(validIssueIdentity({ ...issue, id: 457 }, 456, "I_kwDO-test", 7), false);
    assert.equal(validIssueIdentity({ ...issue, pull_request: { url: "https://api.github.com/pulls/7" } }, 456, "I_kwDO-test", 7), false);
  });

  it("accepts only HMAC-signed issue-opened dispatch envelopes", async () => {
    const secret = "test-secret";
    const event = { action: "opened", organization: { login: "Ateliers-Dev" }, repository: { ...repository, name: "new-project" }, issue: { ...issue, html_url: "https://github.com/Ateliers-Dev/new-project/issues/7" } };
    assert.equal(validateIssueEvent(event, "Ateliers-Dev"), true);
    const deliveryId = "delivery-7";
    const signature = await signIssueDispatch({ organization: "Ateliers-Dev", repository: event.repository, issue: event.issue, delivery_id: deliveryId }, secret);
    const payload = { action: "issue-opened", organization: "Ateliers-Dev", repository_id: 124, repository_full_name: repository.full_name, issue_id: 456, issue_node_id: issue.node_id, issue_number: 7, delivery_id: deliveryId };
    assert.equal(validIssueDispatch(payload, signature, secret), true);
    assert.equal(validIssueDispatch({ ...payload, issue_number: 8 }, signature, secret), false);
    assert.equal(validIssueDispatch(payload, signature, "wrong-secret"), false);
  });
});

