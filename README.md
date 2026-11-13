# PR-Setinel
# PR Sentinel – AI Pull Request Risk Analyzer

PR Sentinel is an AI-powered GitHub Pull Request Risk Analyzer designed to help developers review code changes more efficiently. It fetches pull request details and changed-file diffs from GitHub using a custom Model Context Protocol (MCP) server and analyzes the changes using a locally running Ollama language model.

The application generates an AI-assisted code review report containing a risk score, risk level, potential issues, code-based evidence, recommended tests, and analysis limitations. These results are displayed through an interactive React dashboard.

## Key Features

- **GitHub Pull Request Analysis:** Fetches pull request details, status, changed files, additions, deletions, and code diffs.
- **Custom MCP Server:** Uses the Model Context Protocol (MCP) to retrieve GitHub pull request information.
- **AI-Powered Code Review:** Uses a local Ollama model to analyze supplied code changes.
- **Risk Assessment:** Generates a risk score and categorizes pull requests by risk level.
- **AI Review Findings:** Identifies potential issues and provides supporting evidence from the supplied diff.
- **Recommended Tests:** Suggests tests based on the analyzed code changes.
- **Analysis Limitations:** Highlights missing context and limitations of AI-generated findings.
- **Interactive Dashboard:** Displays pull request information, AI analysis results, and changed-file diffs.
- **Local AI Inference:** Runs AI analysis locally using Ollama without requiring OpenAI API credits.

## Technology Stack

**Frontend:** React.js, JavaScript, CSS

**Backend:** Node.js, Express.js

**AI/LLM:** Ollama, Qwen2.5-Coder (3B)

**Integration:** Model Context Protocol (MCP), GitHub

**API Communication:** REST API, HTTP

## How It Works

1. The user provides a public GitHub Pull Request URL.
2. The backend communicates with the custom MCP server to retrieve pull request details and changed-file diffs.
3. The retrieved code changes are passed to the locally running Ollama model.
4. The AI analyzes the supplied changes and generates a structured review report.
5. The backend validates the report and returns it to the React frontend.
6. The dashboard displays the risk assessment, findings, code evidence, recommended tests, and analysis limitations.

## Project Objective

The objective of PR Sentinel is to explore how AI and the Model Context Protocol can be used to assist developers with GitHub code reviews by analyzing pull request changes and providing structured, understandable review suggestions.

**Note:** AI-generated findings are suggestions and require human verification. Recommended tests are not automatically executed by the application.
