import * as fs from "node:fs";
import * as path from "node:path";
import type { FailedJobSummary } from "../tensorZeroClient.js";

export interface CIFailureContext {
  repoFullName: string;
  branch: string;
  prNumber: number;
  workflowRunId: number;
  workflowRunUrl: string;
  prUrl: string;
  failedJobs: FailedJobSummary[];
  diffSummary: string;
  fullDiff: string;
  failureLogs: string;
}

/**
 * Generate a markdown document describing the CI failure for the agent to read
 */
export function generateCIFailureContextMarkdown(
  context: CIFailureContext,
): string {
  const {
    repoFullName,
    branch,
    prNumber,
    workflowRunId,
    workflowRunUrl,
    prUrl,
    failedJobs,
    diffSummary,
    fullDiff,
    failureLogs,
  } = context;

  let markdown = `# CI Failure Context

## Overview

- **Repository**: ${repoFullName}
- **Branch**: ${branch}
- **Pull Request**: #${prNumber}
- **PR URL**: ${prUrl}
- **Workflow Run ID**: ${workflowRunId}
- **Workflow Run URL**: ${workflowRunUrl}

## Your Task

Fix the CI failures in this pull request. The tests and checks are failing, and you need to:

1. Analyze the failure logs below to understand what went wrong
2. Review the PR diff to understand what changes were made
3. Make targeted fixes to resolve the failures
4. Run validation commands to ensure your fixes work
5. Decide whether to propose inline suggestions or a pull request

## Failed Jobs and Steps

`;

  for (const job of failedJobs) {
    markdown += `### Job: ${job.name}\n\n`;
    if (job.conclusion) {
      markdown += `- **Conclusion**: ${job.conclusion}\n`;
    }
    if (job.html_url) {
      markdown += `- **URL**: ${job.html_url}\n`;
    }
    markdown += `\n**Failed Steps:**\n\n`;

    for (const step of job.failed_steps) {
      markdown += `- **${step.name}**\n`;
      markdown += `  - Status: ${step.status ?? "unknown"}\n`;
      markdown += `  - Conclusion: ${step.conclusion ?? "unknown"}\n`;
    }
    markdown += `\n`;
  }

  markdown += `## PR Diff Summary

\`\`\`
${diffSummary}
\`\`\`

## Full PR Diff

\`\`\`diff
${fullDiff}
\`\`\`

## Failure Logs

\`\`\`
${failureLogs}
\`\`\`

## Validation Instructions

After making your changes, you MUST validate them by running:

1. **The specific failing tests** - Rerun the tests that failed to ensure they now pass
2. **Linters and formatters** - Run code quality tools to ensure your changes meet style guidelines
3. **Build the project** - Ensure the project still compiles/builds successfully
4. **Language-specific checks** - Run type checkers, cargo clippy, etc. as appropriate

## Decision Criteria

When you've successfully fixed and validated the changes, decide how to present your fix:

**Use INLINE_SUGGESTIONS when:**
- Changes are localized to 1-2 files
- Changes are simple and straightforward
- Total lines changed is small (<20 lines)

**Use PULL_REQUEST when:**
- Changes span multiple files (3+)
- Changes are complex or require significant refactoring
- You need human review for confidence

Output your decision using the completion command format described in your system instructions.

Good luck!
`;

  return markdown;
}

/**
 * Write the CI failure context to a file in the repository
 */
export function writeCIFailureContextFile(
  repoPath: string,
  context: CIFailureContext,
): string {
  const markdown = generateCIFailureContextMarkdown(context);
  const filePath = path.join(repoPath, "ci_failure_context.md");

  fs.writeFileSync(filePath, markdown, { encoding: "utf-8" });

  return filePath;
}
