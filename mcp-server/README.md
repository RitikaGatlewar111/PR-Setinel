# PR Sentinel MCP server

This separate Node.js program provides MCP tools for retrieving GitHub pull
request details and source changes. It does not include the AI review, Express
API, or frontend connection.

## Requirements

- Node.js 18 or newer (the server uses Node's built-in `fetch`).
- A GitHub token is optional for public repositories. A token allows higher API
  limits and access to repositories the token is permitted to read.

## Install and run

In PowerShell, from the project root:

```powershell
cd "C:\MCP SERVER\mcp-server"
npm install
npm start
```

The server communicates with MCP clients over standard input/output. When it
starts, it prints a status message to stderr; stdout is reserved for MCP
messages. Starting it directly in a terminal leaves it waiting for an MCP
client, which is expected. It exits when its input stream is closed, so use an
MCP client such as VS Code Chat to keep the stdio connection open.

VS Code starts `node index.js` directly using the workspace configuration in
`.vscode/mcp.json`. The `npm start` command is useful for manual testing, but npm
prints its own script banner; that banner is not output from the MCP server.

## Optional GitHub token

The project includes an ignored `.env` file. Put a token with read access to the
repository there:

```env
GITHUB_TOKEN=github_pat_your_token_here
```

Keep the token private. Do not paste a real token into source files or share it.
If `.env` is missing, create it from the template:

```powershell
Copy-Item .env.example .env
```

## Tool: `get_pull_request`

The tool accepts:

- `owner`: GitHub account or organization name.
- `repo`: repository name.
- `pull_number`: positive whole-number pull request ID.

It returns the title, state, author, description, branches, change counts,
timestamps, and GitHub URL. Invalid inputs are rejected by the tool schema.
GitHub API and network errors are returned as tool errors with a useful message.

## Tool: `get_changed_files`

Accepts the same `owner`, `repo`, and `pull_number` inputs as `get_pull_request`.
Returns the changed file paths, statuses, addition/deletion counts, and patch
text when GitHub provides it. GitHub does not provide patch text for every file.
The tool follows GitHub's pagination and reads at most 3,000 files.

## Tool: `get_file_content`

Accepts `owner`, `repo`, `pull_number`, and a repository-relative `path`.
Returns the file text from the pull request's head commit, including the source
repository and commit SHA. Unsafe paths are rejected, and files larger than
1 MiB are not returned.

## Test the tools

Use an MCP client such as VS Code Chat, or use the SDK client in a local test.
For example, to retrieve changed files from a public pull request, call
`get_changed_files` with `owner: "facebook"`, `repo: "react"`, and
`pull_number: 1`. Use a returned path with `get_file_content` to fetch its
contents from the pull request head.
