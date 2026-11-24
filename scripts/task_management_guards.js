import { createHmac, timingSafeEqual } from "node:crypto";

const ORGANIZATION = "Ateliers-Dev";

export function validRepositoryIdentity(repository, expectedId, expectedFullName) {
  return Number.isSafeInteger(Number(expectedId)) && Number(expectedId) > 0 &&
    Number(repository?.id) === Number(expectedId) &&
    typeof expectedFullName === "string" && /^Ateliers-Dev\/[A-Za-z0-9._-]+$/i.test(expectedFullName) &&
    repository?.full_name?.toLowerCase() === expectedFullName.toLowerCase() &&
    repository?.owner?.login?.toLowerCase() === ORGANIZATION.toLowerCase() &&
    repository?.archived !== true;
}

export function validIssueIdentity(issue, expectedId, expectedNodeId, expectedNumber) {
  return !issue?.pull_request &&
    Number.isSafeInteger(Number(expectedNumber)) && Number(expectedNumber) > 0 &&
    Number(issue?.number) === Number(expectedNumber) &&
    (!expectedId || Number(issue?.id) === Number(expectedId)) &&
    (!expectedNodeId || issue?.node_id === expectedNodeId);
}

export function validIssueDispatch(payload, signature, secret) {
  if (!secret || payload?.action !== "issue-opened" || payload?.organization !== ORGANIZATION ||
      !Number.isSafeInteger(payload?.repository_id) || payload.repository_id < 1 ||
      typeof payload.repository_full_name !== "string" || !/^Ateliers-Dev\/[A-Za-z0-9._-]+$/i.test(payload.repository_full_name) ||
      !Number.isSafeInteger(payload?.issue_id) || payload.issue_id < 1 ||
      typeof payload.issue_node_id !== "string" || payload.issue_node_id.length === 0 ||
      !Number.isSafeInteger(payload?.issue_number) || payload.issue_number < 1 ||
      typeof payload.delivery_id !== "string" || payload.delivery_id.length === 0 || payload.delivery_id.length > 100 ||
      !/^[0-9a-f]{64}$/.test(signature || "")) return false;

  const message = JSON.stringify(["issue-opened", payload.organization, payload.repository_id, payload.repository_full_name, payload.issue_id, payload.issue_number, payload.delivery_id]);
  const expected = createHmac("sha256", secret).update(message).digest();
  const actual = Buffer.from(signature, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

