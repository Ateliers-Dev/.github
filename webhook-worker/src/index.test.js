import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { signDispatch, validateRepositoryEvent } from "./index.js";
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

