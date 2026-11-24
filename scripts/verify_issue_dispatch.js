import { validIssueDispatch } from "./task_management_guards.js";

const organization = process.env.DISPATCH_ORGANIZATION;
const repositoryId = Number(process.env.DISPATCH_REPOSITORY_ID);
const repositoryFullName = process.env.DISPATCH_REPOSITORY_FULL_NAME;
const issueId = Number(process.env.DISPATCH_ISSUE_ID);
const issueNodeId = process.env.DISPATCH_ISSUE_NODE_ID;
const issueNumber = Number(process.env.DISPATCH_ISSUE_NUMBER);
const deliveryId = process.env.DISPATCH_DELIVERY_ID;
const signature = process.env.DISPATCH_SIGNATURE;
const secret = process.env.COMMON_LABEL_DISPATCH_SECRET;

const valid = validIssueDispatch({ action: "issue-opened", organization, repository_id: repositoryId, repository_full_name: repositoryFullName, issue_id: issueId, issue_node_id: issueNodeId, issue_number: issueNumber, delivery_id: deliveryId }, signature, secret);
if (!valid) {
  console.error("Issue dispatch signature or fields are invalid");
  process.exitCode = 1;
} else console.log("Issue dispatch signature is valid");

