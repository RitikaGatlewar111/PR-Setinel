import React, { useState } from "react";

function validatePullRequestUrl(value) {
  let parsedUrl;
  try {
    parsedUrl = new URL(value.trim());
  } catch {
    return "Enter a valid GitHub pull request URL.";
  }

  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  if (
    parsedUrl.protocol !== "https:" ||
    parsedUrl.hostname !== "github.com" ||
    segments.length !== 4 ||
    segments[2] !== "pull" ||
    !/^\d+$/.test(segments[3])
  ) {
    return "Use a URL like https://github.com/owner/repo/pull/123.";
  }
  return "";
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString() : "—";
}

function AnalysisReport({ report }) {
  const pullRequest = report.pull_request;
  const analysis = report.analysis;
  const files = report.files ?? [];

  return (
    <section className="panel results" aria-labelledby="results-title">
      {analysis.status === "complete" && (
        <div className="retrieval-notice">
          <strong>AI-generated review suggestions</strong>
          <p>Findings are based only on the supplied pull request data and have not been independently verified. No tests were executed.</p>
        </div>
      )}
      <div className="results-heading">
        <div>
          <p className="eyebrow">PULL REQUEST DATA</p>
          <h2 id="results-title">#{pullRequest.number}: {pullRequest.title}</h2>
          <a className="pr-link" href={pullRequest.url} target="_blank" rel="noreferrer">
            {pullRequest.url}
          </a>
        </div>
        {Number.isFinite(analysis.riskScore) && (
          <p className={`score risk-${analysis.riskLevel.toLowerCase()}`}>
            <strong>{analysis.riskScore}</strong> / 100 · {analysis.riskLevel} risk
          </p>
        )}
      </div>

      {analysis.summary && <p className="report-summary">{analysis.summary}</p>}

      <div className="summary-grid">
        <div><span>State</span><strong>{pullRequest.state}</strong></div>
        <div><span>Changed files</span><strong>{files.length}</strong></div>
        <div><span>Additions</span><strong>+{formatNumber(pullRequest.additions)}</strong></div>
        <div><span>Deletions</span><strong>−{formatNumber(pullRequest.deletions)}</strong></div>
      </div>

      <h3>AI review findings</h3>
      {analysis.findings.length ? (
        <div className="findings">
          {analysis.findings.map((finding, index) => (
            <article className="finding" key={`${finding.filePath}-${index}`}>
              <span className={`severity ${finding.severity.toLowerCase()}`}>
                {finding.severity}
              </span>
              <div>
                <h4>{finding.title}</h4>
                <p className="classification">
                  {finding.classification === "confirmed"
                    ? "Evidence-supported AI assessment — not independently verified"
                    : "Potential AI suggestion"}
                  {" · "}{finding.filePath}
                </p>
                <p>{finding.explanation}</p>
                {finding.evidence && (
                  <>
                    <p className="evidence-label"><strong>Code evidence from supplied diff</strong></p>
                    <pre className="evidence">{finding.evidence}</pre>
                  </>
                )}
                {finding.suggestedFix && (
                  <p className="suggested-fix"><strong>Suggested fix:</strong> {finding.suggestedFix}</p>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : <p className="hint">The AI did not identify an evidence-based concern in the supplied changes.</p>}

      <h3>Recommended tests</h3>
      {analysis.recommendedTests.length ? (
        <ul>{analysis.recommendedTests.map((test, index) => <li key={`${index}-${test}`}>{test}</li>)}</ul>
      ) : <p className="hint">No additional tests were recommended. No tests were run.</p>}

      {analysis.limitations.length > 0 && (
        <>
          <h3>Analysis limitations</h3>
          <ul>{analysis.limitations.map((limitation, index) => <li key={`${index}-${limitation}`}>{limitation}</li>)}</ul>
        </>
      )}

      <h3>Changed files</h3>
      <div className="file-list">
        {files.map((file) => (
          <article className="file-row" key={file.filename}>
            <div className="file-heading">
              <code>{file.filename}</code>
              <span className="file-status">{file.status}</span>
            </div>
            {file.previous_filename && (
              <p className="previous-filename">Renamed from <code>{file.previous_filename}</code></p>
            )}
            <p className="file-counts">
              <span className="added">+{file.additions}</span>
              <span className="removed">−{file.deletions}</span>
            </p>
            {(() => {
              const hasPatch = typeof file.patch === "string" && file.patch.length > 0;
              const isAvailable = file.patch_status === "available" || hasPatch;
              if (isAvailable) {
                return (
                  <details>
                    <summary>View diff ({file.patch.split("\n").length} lines)</summary>
                    <pre className="patch">{file.patch}</pre>
                  </details>
                );
              }
              return (
                <p className="no-patch">
                  GitHub did not provide a text diff for this file. This can happen with binary files,
                  very large changes, or some renames.
                </p>
              );
            })()}
          </article>
        ))}
      </div>
    </section>
  );
}

export default function App() {
  const [url, setUrl] = useState("");
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const [report, setReport] = useState(null);

  async function analyze(event) {
    event.preventDefault();
    setError("");
    setReport(null);

    const validationError = validatePullRequestUrl(url);
    if (validationError) {
      setError(validationError);
      setStatus("error");
      return;
    }

    setStatus("loading");
    try {
      const response = await fetch("/api/analyze-pr", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const responseText = await response.text();
      let payload;
      if (responseText.trim()) {
        try {
          payload = JSON.parse(responseText);
        } catch {
          const responseKind = response.ok ? "invalid JSON" : "a non-JSON error";
          throw new Error(
            `The backend returned ${responseKind} (HTTP ${response.status}). Check the backend terminal for errors.`,
          );
        }
      } else if (!response.ok) {
        throw new Error(
          `The request failed with HTTP ${response.status} and an empty response. Make sure the Express backend is running on port 3001.`,
        );
      } else {
        throw new Error(
          "The backend returned an empty response. Make sure the Express backend is running and try again.",
        );
      }
      if (!response.ok) {
        throw new Error(payload.error?.message ?? `Request failed with status ${response.status}.`);
      }
      setReport(payload);
      setStatus("complete");
    } catch (requestError) {
      setError(
        requestError instanceof Error
          ? requestError instanceof TypeError
            ? "Could not connect to the backend. Make sure both the Express backend and Vite are running."
            : requestError.message
          : "Could not fetch this pull request. Check that the backend is running.",
      );
      setStatus("error");
    }
  }

  return (
    <main className="page">
      <header className="header">
        <a className="brand" href="/">PR Sentinel</a>
        <span>Pull request data explorer</span>
      </header>

      <section className="intro">
        <p className="eyebrow">A SECOND PAIR OF EYES</p>
        <h1>Explore your pull request</h1>
        <p>Review real GitHub changes through the PR Sentinel MCP server and get evidence-based AI risk suggestions.</p>
      </section>

      <section className="panel">
        <form onSubmit={analyze} noValidate>
          <label htmlFor="pr-url">GitHub pull request URL</label>
          <div className="form-row">
            <input
              id="pr-url"
              type="url"
              placeholder="https://github.com/owner/repo/pull/123"
              value={url}
              disabled={status === "loading"}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? "url-error" : undefined}
              onChange={(event) => {
                setUrl(event.target.value);
                setError("");
                setReport(null);
                setStatus("idle");
              }}
            />
            <button type="submit" disabled={status === "loading"}>
              {status === "loading" ? "Analyzing…" : "Analyze PR"}
            </button>
          </div>
          {error && <p className="error" id="url-error" role="alert">{error}</p>}
        </form>
      </section>

      {status === "loading" && (
        <p className="notice" role="status">Retrieving pull request data and asking your local Ollama model to analyze the available diffs…</p>
      )}
      {status === "idle" && (
        <p className="hint">Enter a GitHub pull request URL to retrieve its details, review the available diffs, and get AI risk suggestions.</p>
      )}
      {status === "complete" && report && <AnalysisReport report={report} />}
    </main>
  );
}
