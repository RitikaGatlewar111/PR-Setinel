import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const GITHUB_API = "https://api.github.com";
const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
const MAX_CHANGED_FILES = 3000;
const FILES_PER_PAGE = 100;

class GitHubRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GitHubRequestError";
    this.status = status;
  }
}

const server = new McpServer({
  name: "pr-sentinel",
  version: "1.0.0",
});

const ownerSchema = z
  .string()
  .min(1)
  .max(39)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/, "Invalid GitHub owner name");
const repoSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/, "Invalid GitHub repository name");
const pullNumberSchema = z.number().int().positive().safe();
const pullRequestSchema = {
  owner: ownerSchema,
  repo: repoSchema,
  pull_number: pullNumberSchema,
};

function redactToken(message) {
  const token = process.env.GITHUB_TOKEN?.trim();
  return token ? message.replaceAll(token, "[REDACTED]") : message;
}

function repositoryPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

async function githubRequest(path, { accept = "application/vnd.github+json", raw = false } = {}) {
  const headers = {
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "pr-sentinel-mcp-server",
  };
  const token = process.env.GITHUB_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const url = `${GITHUB_API}${path}`;
  let response;
  try {
    response = await fetch(url, { method: "GET", headers });
  } catch (error) {
    const message = redactToken(
      error instanceof Error ? error.message : "Unknown network error",
    );
    console.error(`[pr-sentinel] GitHub request failed: ${message}`);
    throw new GitHubRequestError(`Could not reach the GitHub API: ${message}`);
  }

  if (!response.ok) {
    let githubMessage = "GitHub did not provide an error message.";
    try {
      const errorBody = await response.json();
      if (
        errorBody &&
        typeof errorBody === "object" &&
        typeof errorBody.message === "string"
      ) {
        githubMessage = errorBody.message;
      }
    } catch {
      githubMessage = "GitHub returned a non-JSON error response.";
    }

    const message = redactToken(
      `GitHub API request failed with HTTP ${response.status}: ${githubMessage}`,
    );
    console.error(`[pr-sentinel] ${path} failed: ${message}`);
    throw new GitHubRequestError(message, response.status);
  }

  if (raw) {
    return {
      text: await response.text(),
      contentType: response.headers.get("content-type") ?? "",
    };
  }

  try {
    return await response.json();
  } catch {
    throw new GitHubRequestError("GitHub returned an unreadable JSON response.");
  }
}

function toolError(error) {
  const message = redactToken(
    error instanceof Error ? error.message : "An unexpected error occurred.",
  );
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

async function fetchPullRequest(owner, repo, pullNumber) {
  return githubRequest(`${repositoryPath(owner, repo)}/pulls/${pullNumber}`);
}

function pullRequestDetails(pullRequest) {
  return {
    title: pullRequest.title,
    number: pullRequest.number,
    state: pullRequest.state,
    draft: pullRequest.draft,
    url: pullRequest.html_url,
    author: pullRequest.user?.login ?? null,
    body: pullRequest.body,
    base_branch: pullRequest.base?.ref,
    head_branch: pullRequest.head?.ref,
    head_sha: pullRequest.head?.sha,
    created_at: pullRequest.created_at,
    updated_at: pullRequest.updated_at,
    additions: pullRequest.additions,
    deletions: pullRequest.deletions,
    changed_files: pullRequest.changed_files,
  };
}

function isValidRepositoryPath(path) {
  const trimmed = path.trim();
  return (
    trimmed.length > 0 &&
    trimmed.length <= 1024 &&
    !trimmed.startsWith("/") &&
    !trimmed.includes("\\") &&
    !trimmed.includes("\0") &&
    trimmed.split("/").every((segment) => segment && segment !== "." && segment !== "..")
  );
}

server.registerTool(
  "get_pull_request",
  {
    title: "Get pull request details",
    description:
      "Retrieve details for a GitHub pull request by repository owner, repository name, and pull request number.",
    inputSchema: pullRequestSchema,
  },
  async ({ owner, repo, pull_number }) => {
    try {
      const pullRequest = await fetchPullRequest(owner, repo, pull_number);
      const details = pullRequestDetails(pullRequest);
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        structuredContent: details,
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_changed_files",
  {
    title: "Get pull request changed files",
    description:
      "List files changed by a pull request, including status, line counts, and patch text when GitHub provides it.",
    inputSchema: pullRequestSchema,
  },
  async ({ owner, repo, pull_number }) => {
    try {
      const files = [];
      for (let page = 1; page <= MAX_CHANGED_FILES / FILES_PER_PAGE; page += 1) {
        const pagePath =
          `${repositoryPath(owner, repo)}/pulls/${pull_number}/files` +
          `?per_page=${FILES_PER_PAGE}&page=${page}`;
        const pageFiles = await githubRequest(pagePath);
        if (!Array.isArray(pageFiles)) {
          throw new GitHubRequestError("GitHub returned an unexpected changed-files response.");
        }

        files.push(
          ...pageFiles.map((file) => ({
            filename: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            changes: file.changes,
            patch: file.patch ?? null,
            previous_filename: file.previous_filename ?? null,
          })),
        );

        if (pageFiles.length < FILES_PER_PAGE) {
          break;
        }
      }

      const details = {
        owner,
        repo,
        pull_number,
        file_count: files.length,
        truncated: files.length === MAX_CHANGED_FILES,
        files,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        structuredContent: details,
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "get_file_content",
  {
    title: "Get pull request file content",
    description:
      "Get a file's contents from the head commit of a pull request. Use a repository-relative file path.",
    inputSchema: {
      ...pullRequestSchema,
      path: z
        .string()
        .min(1)
        .max(1024)
        .refine(isValidRepositoryPath, "Use a safe repository-relative file path"),
    },
  },
  async ({ owner, repo, pull_number, path }) => {
    try {
      const pullRequest = await fetchPullRequest(owner, repo, pull_number);
      const headSha = pullRequest.head?.sha;
      const headRepository = pullRequest.head?.repo;
      if (
        typeof headSha !== "string" ||
        !headSha ||
        typeof headRepository?.owner?.login !== "string" ||
        typeof headRepository?.name !== "string"
      ) {
        throw new GitHubRequestError(
          "The pull request's head repository is unavailable, so its file content cannot be retrieved.",
        );
      }

      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const contentPath =
        `${repositoryPath(headRepository.owner.login, headRepository.name)}/contents/${encodedPath}` +
        `?ref=${encodeURIComponent(headSha)}`;
      const result = await githubRequest(contentPath, {
        accept: "application/vnd.github.raw+json",
        raw: true,
      });
      const contentBytes = Buffer.byteLength(result.text, "utf8");
      if (contentBytes > MAX_FILE_CONTENT_BYTES) {
        throw new GitHubRequestError(
          `The requested file is larger than the ${MAX_FILE_CONTENT_BYTES / 1024 / 1024} MiB content limit.`,
        );
      }

      const details = {
        owner,
        repo,
        pull_number,
        path,
        source_repo: `${headRepository.owner.login}/${headRepository.name}`,
        ref: headSha,
        content_type: result.contentType,
        size_bytes: contentBytes,
        content: result.text,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details, null, 2) }],
        structuredContent: details,
      };
    } catch (error) {
      return toolError(error);
    }
  },
);

const transport = new StdioServerTransport();
try {
  await server.connect(transport);
  console.error("[pr-sentinel] MCP server is running over stdio.");
} catch (error) {
  const message = redactToken(
    error instanceof Error ? error.message : "Unknown startup error",
  );
  console.error(`[pr-sentinel] Failed to start: ${message}`);
  process.exitCode = 1;
}
