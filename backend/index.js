
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  analyzePullRequest as analyzeWithOllama,
  OllamaConfigurationError,
  OllamaRequestError,
} from "./services/ollamaAnalysis.js";

import {
  analyzePullRequest as analyzeWithGemini,
  GeminiConfigurationError,
  GeminiRequestError,
} from "./services/geminiAnalysis.js";

const backendDirectory = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(backendDirectory, ".env") });

const projectDirectory = path.resolve(backendDirectory, "..");
const mcpServerDirectory = path.join(projectDirectory, "mcp-server");

const port = readPositiveInteger(process.env.PORT, 3001);
const maxPullRequestFiles = readPositiveInteger(process.env.MAX_PR_FILES, 50);

const aiProvider = (process.env.AI_PROVIDER || "ollama")
  .trim()
  .toLowerCase();

const maxAnalysisInputChars = readPositiveInteger(
  process.env.AI_MAX_INPUT_CHARS ?? process.env.OLLAMA_MAX_INPUT_CHARS,
  90_000,
);

const analysisTimeoutMs = readPositiveInteger(
  process.env.AI_TIMEOUT_MS ?? process.env.OLLAMA_TIMEOUT_MS,
  180_000,
);

function readPositiveInteger(value, fallback) {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsedValue = Number(value);

  return Number.isSafeInteger(parsedValue) && parsedValue > 0
    ? parsedValue
    : fallback;
}

class ApiError extends Error {
  constructor(status, code, message, upstreamStatus) {
    super(message);
    this.status = status;
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

const app = express();

app.use(express.json({ limit: "16kb" }));

const mcpClient = new Client({
  name: "pr-sentinel-backend",
  version: "1.0.0",
});

const providers = {
  ollama: {
    analyze: analyzeWithOllama,
    label: "Ollama",
  },
  gemini: {
    analyze: analyzeWithGemini,
    label: "Gemini",
  },
};

function parsePullRequestUrl(value) {
  if (typeof value !== "string" || value.trim().length > 2048) {
    throw new ApiError(400, "invalid_url", "Provide a GitHub pull request URL.");
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(value.trim());
  } catch {
    throw new ApiError(400, "invalid_url", "The pull request URL is not valid.");
  }

  const segments = parsedUrl.pathname.split("/").filter(Boolean);

  const isValidPullRequestUrl =
    parsedUrl.protocol === "https:" &&
    parsedUrl.hostname === "github.com" &&
    parsedUrl.port === "" &&
    !parsedUrl.username &&
    !parsedUrl.password &&
    segments.length === 4 &&
    segments[2] === "pull" &&
    /^\d+$/.test(segments[3]);

  if (!isValidPullRequestUrl) {
    throw new ApiError(
      400,
      "invalid_url",
      "Use a GitHub pull request URL like https://github.com/owner/repo/pull/123.",
    );
  }

  let owner;
  let repo;

  try {
    owner = decodeURIComponent(segments[0]);
    repo = decodeURIComponent(segments[1]);
  } catch {
    throw new ApiError(
      400,
      "invalid_url",
      "The owner or repository in the URL is invalid.",
    );
  }

  const pullNumber = Number(segments[3]);

  const validOwner = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(owner);
  const validRepo = /^[A-Za-z0-9_.-]+$/.test(repo);

  if (
    !validOwner ||
    owner.length > 39 ||
    !validRepo ||
    repo.length > 100 ||
    !Number.isSafeInteger(pullNumber) ||
    pullNumber < 1
  ) {
    throw new ApiError(
      400,
      "invalid_url",
      "The owner, repository, or pull request number is invalid.",
    );
  }

  return {
    owner,
    repo,
    pull_number: pullNumber,
  };
}

function unwrapToolResult(result, toolName) {
  const message = result.content
    ?.filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");

  if (result.isError) {
    const statusMatch = message?.match(/HTTP (\d{3}):/);
    const upstreamStatus = statusMatch ? Number(statusMatch[1]) : undefined;

    const status = upstreamStatus === 404 ? 404 : 502;

    const code =
      upstreamStatus === 401
        ? "github_auth_error"
        : upstreamStatus === 404
          ? "github_not_found"
          : upstreamStatus
            ? "github_api_error"
            : "mcp_tool_error";

    const explanation =
      upstreamStatus === 404
        ? `${message}. A 404 may also mean the repository is private and the GitHub token lacks access.`
        : upstreamStatus === 401
          ? `${message} Check the token in mcp-server/.env; public repositories can be accessed without a token.`
          : message || `The MCP tool ${toolName} failed.`;

    throw new ApiError(status, code, explanation, upstreamStatus);
  }

  if (result.structuredContent) {
    return result.structuredContent;
  }

  if (message) {
    try {
      return JSON.parse(message);
    } catch {
      throw new ApiError(
        502,
        "invalid_mcp_response",
        `The MCP tool ${toolName} returned invalid JSON.`,
      );
    }
  }

  throw new ApiError(
    502,
    "empty_mcp_response",
    `The MCP tool ${toolName} returned no data.`,
  );
}

async function callMcpTool(name, args) {
  try {
    const result = await mcpClient.callTool({
      name,
      arguments: args,
    });

    return unwrapToolResult(result, name);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    const detail =
      error instanceof Error ? error.message : "Unknown MCP client error";

    throw new ApiError(
      502,
      "mcp_unavailable",
      `Could not call MCP tool ${name}: ${detail}`,
    );
  }
}

app.get("/api/health", (_request, response) => {
  response.json({
    status: "ok",
    mcp_server: "connected",
  });
});

app.post("/api/analyze-pr", async (request, response) => {
  try {
    const selectedProvider = providers[aiProvider];

    if (!selectedProvider) {
      throw new ApiError(
        500,
        "invalid_ai_provider",
        "AI_PROVIDER must be either 'ollama' or 'gemini'.",
      );
    }

    const pullRequestInput = parsePullRequestUrl(request.body?.url);

    const pullRequest = await callMcpTool(
      "get_pull_request",
      pullRequestInput,
    );

    const changedFiles = await callMcpTool(
      "get_changed_files",
      pullRequestInput,
    );

    if (!Array.isArray(changedFiles.files)) {
      throw new ApiError(
        502,
        "invalid_mcp_response",
        "The MCP server returned an invalid changed-files list.",
      );
    }

    const reportFiles = changedFiles.files
      .slice(0, maxPullRequestFiles)
      .map((file) => {
        const patch =
          typeof file.patch === "string" && file.patch.length > 0
            ? file.patch
            : null;

        return {
          ...file,
          patch,
          patch_status: patch ? "available" : "unavailable",
        };
      });

    const limitations = [];

    if (changedFiles.files.length > reportFiles.length) {
      limitations.push(
        `Only ${reportFiles.length} of ${changedFiles.files.length} changed files were included because MAX_PR_FILES is ${maxPullRequestFiles}.`,
      );
    }

    if (changedFiles.truncated) {
      limitations.push(
        "The MCP server reached its 3,000-file retrieval cap; additional changed files may not be included.",
      );
    }

    const analysis = await selectedProvider.analyze({
      pullRequest,
      changedFiles: reportFiles,
      maxInputChars: maxAnalysisInputChars,
      timeoutMs: analysisTimeoutMs,
    });

    response.json({
      pull_request: pullRequest,
      files: reportFiles,
      total_changed_files:
        pullRequest.changed_files ?? changedFiles.file_count,
      analysis: {
        status: "complete",
        provider: selectedProvider.label,
        ...analysis,
        limitations: [...analysis.limitations, ...limitations],
      },
    });
  } catch (error) {
    if (
      error instanceof OllamaConfigurationError ||
      error instanceof OllamaRequestError ||
      error instanceof GeminiConfigurationError ||
      error instanceof GeminiRequestError
    ) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
        },
      });
      return;
    }

    if (error instanceof ApiError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: error.message,
          ...(error.upstreamStatus
            ? { upstream_status: error.upstreamStatus }
            : {}),
        },
      });
      return;
    }

    const detail =
      error instanceof Error ? error.message : "Unknown server error";

    console.error(
      `[pr-sentinel-backend] Analysis request failed: ${detail}`,
    );

    response.status(500).json({
      error: {
        code: "internal_error",
        message: "The server could not process this request.",
      },
    });
  }
});

// Serve the React frontend in production
app.use(express.static(path.join(projectDirectory, "dist")));

// Handle React frontend routes
app.use((request, response, next) => {
  if (
    request.method === "GET" &&
    !request.path.startsWith("/api")
  ) {
    response.sendFile(
      path.join(projectDirectory, "dist", "index.html"),
    );
    return;
  }

  next();
});

app.use((error, _request, response, _next) => {
  if (error?.type === "entity.too.large") {
    response.status(413).json({
      error: {
        code: "request_too_large",
        message: "The request body is too large.",
      },
    });
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({
      error: {
        code: "invalid_json",
        message: "The request body must contain valid JSON.",
      },
    });
    return;
  }

  console.error("[pr-sentinel-backend] Request middleware failed.");

  response.status(500).json({
    error: {
      code: "internal_error",
      message: "The server could not process this request.",
    },
  });
});

let httpServer;

async function start() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["index.js"],
    cwd: mcpServerDirectory,
    stderr: "inherit",
  });

  await mcpClient.connect(transport);

  const { tools } = await mcpClient.listTools();

  const toolNames = new Set(tools.map((tool) => tool.name));

  for (const requiredTool of ["get_pull_request", "get_changed_files"]) {
    if (!toolNames.has(requiredTool)) {
      throw new Error(
        `The MCP server does not provide the required ${requiredTool} tool.`,
      );
    }
  }

  httpServer = app.listen(port, () => {
    console.info(
      `[pr-sentinel-backend] Listening on http://localhost:${port}`,
    );
    console.info(
      `[pr-sentinel-backend] AI provider: ${aiProvider}`,
    );
  });
}

async function stop() {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }

  await mcpClient.close();
}

process.once("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});

start().catch((error) => {
  const message =
    error instanceof Error ? error.message : "Unknown startup error";

  console.error(
    `[pr-sentinel-backend] Could not start: ${message}`,
  );

  process.exitCode = 1;
});
