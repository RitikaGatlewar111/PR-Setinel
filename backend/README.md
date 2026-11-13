# PR Sentinel backend

This Express API connects the React dashboard to the separate custom MCP server
and a locally running Ollama model. It starts `mcp-server/index.js` as a child
process over stdio using the official MCP SDK client. For each submitted pull
request URL, it calls `get_pull_request` and `get_changed_files`, then sends the
bounded, available diff evidence to Ollama for a structured risk review.

## Install and run

In PowerShell, start the backend:

```powershell
cd "C:\MCP SERVER\backend"
npm install
npm start
```

The API listens on `http://localhost:3001` by default. It starts and connects
to the MCP server automatically; do not start a second MCP process for this
backend. The MCP server's GitHub token, if needed, stays in
`mcp-server/.env`, not in the frontend.

Ensure Ollama is running locally and that the model is available:

```powershell
ollama pull qwen2.5-coder:3b
ollama run qwen2.5-coder:3b
```

The backend calls `http://localhost:11434/api/chat` using
`qwen2.5-coder:3b` by default. Optional settings in `backend/.env` are
`OLLAMA_URL`, `OLLAMA_MODEL`, `OLLAMA_MAX_INPUT_CHARS`, and
`OLLAMA_TIMEOUT_MS`. No OpenAI API key or SDK is required.

In a second terminal, start the React dashboard:

```powershell
cd "C:\MCP SERVER"
npm run dev
```

Open the local Vite URL printed in the terminal and submit a public GitHub PR
URL. Private repositories need a GitHub token with access in
`mcp-server/.env`.

## Request and response

`POST /api/analyze-pr` accepts:

```json
{
  "url": "https://github.com/facebook/react/pull/1"
}
```

The endpoint validates the URL, retrieves PR data through the MCP server,
analyzes available diffs, and returns the metadata, file details, and an
`analysis` object with `riskScore`, `riskLevel`, `summary`, `findings`,
`recommendedTests`, and `limitations`. Each finding is an AI assessment based
on supplied diff evidence, not an independently verified bug. Tests suggested
by the model are recommendations; the analyzer does not execute them.

`MAX_PR_FILES` limits the number of files included (default 50).
`OLLAMA_MAX_INPUT_CHARS` limits the serialized code/context sent for analysis
(default 90000), and `OLLAMA_TIMEOUT_MS` sets the request timeout (default
180000). Truncated or unavailable patches are described in `limitations`.

Invalid URLs return HTTP 400. Ollama connection and timeout errors return
useful JSON errors. GitHub/MCP errors preserve useful upstream status
information. Analysis failures do not return a success-shaped or fabricated
report.

## Tests

From `backend/`, run:

```powershell
npm test
```

The Ollama service unit tests use mocked responses and do not contact a model.
For an end-to-end check, make sure Ollama is running, then start the backend and
dashboard and submit a small public GitHub pull request.
