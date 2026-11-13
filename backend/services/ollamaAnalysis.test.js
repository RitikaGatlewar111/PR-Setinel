import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzePullRequest,
  getOllamaConfig,
  OllamaConfigurationError,
  OllamaRequestError,
} from "./ollamaAnalysis.js";

const pullRequest = {
  title: "Add example behavior",
  body: "Please review these changes.",
  state: "open",
  base_branch: "main",
  head_branch: "example",
};

function makeReport(overrides = {}) {
  return {
    riskScore: 18,
    riskLevel: "Low",
    summary: "The supplied change adds a small helper.",
    findings: [],
    recommendedTests: ["Add a test for the helper's empty input."],
    limitations: [],
    analyzedFiles: ["src/helper.js"],
    ...overrides,
  };
}

function ollamaResponse(report) {
  return new Response(JSON.stringify({ message: { content: JSON.stringify(report) }, done: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("uses the local Ollama URL and model without requiring credentials", () => {
  assert.deepEqual(
    getOllamaConfig({}),
    {
      endpoint: "http://localhost:11434/api/chat",
      model: "qwen2.5-coder:3b",
    },
  );
  assert.deepEqual(
    getOllamaConfig({
      OLLAMA_URL: "http://127.0.0.1:11434/",
      OLLAMA_MODEL: "custom-model",
    }),
    {
      endpoint: "http://127.0.0.1:11434/api/chat",
      model: "custom-model",
    },
  );
  assert.throws(
    () => getOllamaConfig({ OLLAMA_URL: "file:///tmp/ollama" }),
    OllamaConfigurationError,
  );
});

test("sends actual PR diffs to Ollama and validates its report", async () => {
  let request;
  const report = makeReport({
    findings: [{
      title: "Potential fallback issue",
      filePath: "src/helper.js",
      severity: "Low",
      classification: "potential",
      explanation: "The new branch may skip the fallback.",
      evidence: "+if (value) return value;",
      suggestedFix: "Add a fallback branch.",
    }],
  });
  const result = await analyzePullRequest({
    pullRequest,
    changedFiles: [{
      filename: "src/helper.js",
      status: "modified",
      additions: 3,
      deletions: 1,
      patch: "+if (value) return value;\n+const api_key = \"sk-123456789012345678901234\";",
    }],
    env: {},
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return ollamaResponse(report);
    },
  });

  assert.equal(request.url, "http://localhost:11434/api/chat");
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["Content-Type"], "application/json");
  assert.equal(request.body.model, "qwen2.5-coder:3b");
  assert.equal(request.body.stream, false);
  assert.equal(request.body.format.type, "object");
  assert.equal(request.body.format.additionalProperties, false);
  assert.deepEqual(request.body.format.required, [
    "riskScore",
    "riskLevel",
    "summary",
    "findings",
    "recommendedTests",
    "limitations",
    "analyzedFiles",
  ]);
  assert.equal(request.body.messages[1].role, "user");
  assert.match(request.body.messages[1].content, /if \(value\) return value;/);
  assert.doesNotMatch(request.body.messages[1].content, /sk-123456789012345678901234/);
  assert.equal(result.riskScore, 18);
  assert.equal(result.findings[0].filePath, "src/helper.js");
  assert.deepEqual(result.analyzedFiles, ["src/helper.js"]);
});

test("records patches omitted by the input limit and files without patches", async () => {
  const result = await analyzePullRequest({
    pullRequest,
    changedFiles: [
      { filename: "src/no-patch.js", patch: null },
      { filename: "src/first.js", patch: "+const first = true;" },
      { filename: "src/omitted.js", patch: "+".repeat(400) },
    ],
    env: {},
    maxInputChars: 350,
    fetchImpl: async (_url, options) => {
      const userContent = JSON.parse(options.body).messages[1].content;
      assert.ok(userContent.length <= 350);
      const inputFiles = JSON.parse(userContent).changed_files;
      assert.equal(inputFiles[0].patch, null);
      assert.ok(inputFiles[1].patch.length > 0);
      assert.ok(inputFiles[1].patch.length < "+const first = true;".length);
      return ollamaResponse(makeReport({ analyzedFiles: [] }));
    },
  });

  assert.ok(result.limitations.some((item) => item.includes("truncated")));
  assert.ok(result.limitations.some((item) => item.includes("did not provide a patch")));
});

test("returns a useful error for malformed model JSON", async () => {
  await assert.rejects(
    analyzePullRequest({
      pullRequest,
      changedFiles: [],
      env: {},
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: { content: "not JSON" } }), { status: 200 }),
    }),
    (error) =>
      error instanceof OllamaRequestError &&
      error.status === 502 &&
      error.message.includes("invalid JSON"),
  );
});

test("rejects reports with invalid fields", async () => {
  await assert.rejects(
    analyzePullRequest({
      pullRequest,
      changedFiles: [{ filename: "src/helper.js", patch: "+const value = true;" }],
      env: {},
      fetchImpl: async () => ollamaResponse(makeReport({ riskScore: 101 })),
    }),
    (error) => error instanceof OllamaRequestError && error.status === 502,
  );
});

test("omits unsupported findings and explains the limitation instead of failing the report", async () => {
  const result = await analyzePullRequest({
    pullRequest,
    changedFiles: [{ filename: "src/helper.js", patch: "+const value = true;" }],
    env: {},
    fetchImpl: async () =>
      ollamaResponse(makeReport({
        findings: [{
          title: "Unsupported claim",
          filePath: "src/helper.js",
          severity: "High",
          classification: "confirmed",
          explanation: "This code has a problem.",
          evidence: "unprovided code",
          suggestedFix: "Change the code.",
        }],
      })),
  });

  assert.deepEqual(result.findings, []);
  assert.ok(result.limitations.some((item) => item.includes("excluded")));
});

test("matches code evidence without diff markers and returns the exact supplied diff line", async () => {
  const result = await analyzePullRequest({
    pullRequest,
    changedFiles: [{ filename: "src/helper.js", patch: "+const value = true;\n const existing = 1;" }],
    env: {},
    fetchImpl: async () =>
      ollamaResponse(makeReport({
        findings: [{
          title: "Potential issue",
          filePath: "SRC/HELPER.JS",
          severity: "Low",
          classification: "potential",
          explanation: "Review the new value.",
          evidence: "const value = true;",
          suggestedFix: "Confirm the value is intended.",
        }],
      })),
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].filePath, "src/helper.js");
  assert.equal(result.findings[0].evidence, "+const value = true;");
});

test("handles Ollama timeouts and connection errors without hiding their cause", async () => {
  await assert.rejects(
    analyzePullRequest({
      pullRequest,
      changedFiles: [],
      env: {},
      fetchImpl: async () => {
        const error = new Error("aborted");
        error.name = "TimeoutError";
        throw error;
      },
    }),
    (error) => error instanceof OllamaRequestError && error.status === 504,
  );
  await assert.rejects(
    analyzePullRequest({
      pullRequest,
      changedFiles: [],
      env: {},
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      },
    }),
    (error) =>
      error instanceof OllamaRequestError &&
      error.status === 503 &&
      error.message.includes("Make sure Ollama is running"),
  );
});

test("handles Ollama HTTP errors without returning a fake report", async () => {
  await assert.rejects(
    analyzePullRequest({
      pullRequest,
      changedFiles: [],
      env: {},
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "model not found" }), { status: 404 }),
    }),
    (error) =>
      error instanceof OllamaRequestError &&
      error.status === 502 &&
      error.message.includes("model not found"),
  );
});
