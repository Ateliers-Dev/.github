const API = "https://api.github.com";
const ORG = "Ateliers-Dev";
const PROJECT_NUMBER = 1;
const token = process.env.TASK_MANAGER_TOKEN;
const mode = process.env.TASK_SYNC_MODE || "event";
const dryRun = process.env.TASK_SYNC_DRY_RUN !== "false";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rest(path) {
  const response = await fetch(`${API}${path}`, { headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "Ateliers-Dev-task-management-sync" } });
  if (!response.ok) throw new Error(`GitHub REST request failed (${response.status}) for ${path}`);
  return response.json();
}

async function graphql(query, variables = {}) {
  const response = await fetch(`${API}/graphql`, { method: "POST", headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "Ateliers-Dev-task-management-sync" }, body: JSON.stringify({ query, variables }) });
  if (!response.ok) throw new Error(`GitHub GraphQL request failed (${response.status})`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(`GitHub GraphQL returned ${body.errors.length} error(s): ${body.errors.map((item) => item.type || "UNKNOWN").join(",")}`);
  return body.data;
}

async function projectId() {
  const data = await graphql("query($org:String!, $number:Int!) { organization(login:$org) { projectV2(number:$number) { id } } }", { org: ORG, number: PROJECT_NUMBER });
  const id = data.organization?.projectV2?.id;
  assert(id, `Organization project ${PROJECT_NUMBER} was not found`);
  return id;
}

async function validateIssue({ repositoryFullName, repositoryId, issueNumber, issueId, issueNodeId }) {
  assert(/^Ateliers-Dev\/[A-Za-z0-9._-]+$/i.test(repositoryFullName || ""), "Repository is outside Ateliers-Dev or has an invalid name");
  assert(Number.isSafeInteger(Number(repositoryId)) && Number(repositoryId) > 0, "Repository ID is invalid");
  assert(Number.isSafeInteger(Number(issueNumber)) && Number(issueNumber) > 0, "Issue number is invalid");
  const repository = await rest(`/repos/${repositoryFullName}`);
  assert(validRepositoryIdentity(repository, repositoryId, repositoryFullName), "Repository identity does not match the signed event or is archived");
  const issue = await rest(`/repos/${repositoryFullName}/issues/${Number(issueNumber)}`);
  assert(validIssueIdentity(issue, issueId, issueNodeId, issueNumber), "Issue identity does not match the signed event, or the item is a pull request");
  assert(issue.repository_url?.endsWith(`/repos/${repositoryFullName}`), "Issue repository does not match the requested repository");
  return { id: issue.node_id, repository: repositoryFullName, number: issue.number, url: issue.html_url };
}

async function addIssue(project, issue) {
  if (dryRun) {
    console.log(JSON.stringify({ result: "would-add", issue: issue.url }));
    return "would-add";
  }
  const data = await graphql("mutation($project:ID!, $content:ID!) { addProjectV2ItemById(input:{projectId:$project, contentId:$content}) { item { id } } }", { project, content: issue.id });
  assert(data.addProjectV2ItemById?.item?.id, "Project mutation returned no item");
  console.log(JSON.stringify({ result: "added-or-already-present", issue: issue.url }));
  return "added-or-already-present";
}

async function listProjectIssues(project) {
  const ids = new Set();
  let cursor = null;
  do {
    const data = await graphql("query($id:ID!, $cursor:String) { node(id:$id) { ... on ProjectV2 { items(first:100, after:$cursor) { nodes { content { ... on Issue { id } } } pageInfo { hasNextPage endCursor } } } } }", { id: project, cursor });
    const page = data.node?.items;
    assert(page, "Unable to read project items");
    for (const item of page.nodes) if (item.content?.id) ids.add(item.content.id);
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return ids;
}

async function listOpenIssues() {
  const issues = [];
  for (let repoPage = 1; ; repoPage++) {
    const repositories = await rest(`/orgs/${ORG}/repos?type=all&per_page=100&page=${repoPage}`);
    if (repositories.length === 0) break;
    for (const repository of repositories) {
      if (repository.archived || repository.owner?.login?.toLowerCase() !== ORG.toLowerCase()) continue;
      for (let issuePage = 1; ; issuePage++) {
        const page = await rest(`/repos/${repository.full_name}/issues?state=open&per_page=100&page=${issuePage}`);
        if (page.length === 0) break;
        for (const issue of page) if (!issue.pull_request) issues.push({ id: issue.node_id, repository: repository.full_name, number: issue.number, url: issue.html_url });
      }
    }
  }
  return issues;
}

async function main() {
  assert(token, "TASK_MANAGER_TOKEN is required");
  const project = await projectId();

  if (mode === "event") {
    const issue = await validateIssue({
      repositoryFullName: process.env.DISPATCH_REPOSITORY_FULL_NAME,
      repositoryId: process.env.DISPATCH_REPOSITORY_ID,
      issueNumber: process.env.DISPATCH_ISSUE_NUMBER,
      issueId: process.env.DISPATCH_ISSUE_ID,
      issueNodeId: process.env.DISPATCH_ISSUE_NODE_ID,
    });
    await addIssue(project, issue);
    return;
  }

  assert(mode === "import-open-issues" || mode === "audit-open-issues", "Unknown synchronization mode");
  const [issues, existing] = await Promise.all([listOpenIssues(), listProjectIssues(project)]);
  const missing = issues.filter((issue) => !existing.has(issue.id));
  console.log(JSON.stringify({ mode, openIssues: issues.length, projectIssues: existing.size, missing: missing.length, dryRun }));
  if (mode === "audit-open-issues") {
    for (const issue of missing) console.log(JSON.stringify({ result: "missing", issue: issue.url }));
    return;
  }
  for (const issue of missing) await addIssue(project, issue);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Task synchronization failed");
  process.exitCode = 1;
});
import { validIssueIdentity, validRepositoryIdentity } from "./task_management_guards.js";


