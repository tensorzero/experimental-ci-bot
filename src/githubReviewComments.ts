import { Octokit } from "@octokit/rest";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * A single file change with hunks
 */
export interface FileChange {
  path: string;
  hunks: DiffHunk[];
}

/**
 * A hunk in a git diff
 */
export interface DiffHunk {
  /**
   * Starting line number in the new file
   */
  startLine: number;

  /**
   * Number of lines in this hunk
   */
  lineCount: number;

  /**
   * The actual diff content (including context)
   */
  content: string;

  /**
   * The suggested replacement content (without diff markers)
   */
  suggestedContent: string;
}

/**
 * A review comment to post on GitHub
 */
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Parse git diff output to extract file changes with hunks
 */
export async function parseGitDiff(
  repoPath: string,
): Promise<FileChange[]> {
  const { stdout } = await execAsync("git diff --unified=3", { cwd: repoPath, maxBuffer: 20 * 1024 * 1024 });

  const changes: FileChange[] = [];
  let currentFile: FileChange | null = null;
  let currentHunk: DiffHunk | null = null;
  let hunkLines: string[] = [];

  const lines = stdout.split("\n");

  for (const line of lines) {
    // New file header
    if (line.startsWith("diff --git")) {
      if (currentFile && currentHunk) {
        currentHunk.content = hunkLines.join("\n");
        currentHunk.suggestedContent = extractSuggestedContent(hunkLines);
        currentFile.hunks.push(currentHunk);
      }
      currentFile = null;
      currentHunk = null;
      hunkLines = [];
      continue;
    }

    // File path (--- and +++)
    if (line.startsWith("+++ b/")) {
      const path = line.substring(6);
      if (path !== "/dev/null") {
        currentFile = { path, hunks: [] };
        changes.push(currentFile);
      }
      continue;
    }

    // Hunk header (@@ -start,count +start,count @@)
    if (line.startsWith("@@")) {
      // Save previous hunk if exists
      if (currentFile && currentHunk) {
        currentHunk.content = hunkLines.join("\n");
        currentHunk.suggestedContent = extractSuggestedContent(hunkLines);
        currentFile.hunks.push(currentHunk);
      }

      // Parse new hunk
      const match = line.match(/@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/);
      if (match && currentFile) {
        const startLine = parseInt(match[1], 10);
        const lineCount = match[2] ? parseInt(match[2], 10) : 1;
        currentHunk = {
          startLine,
          lineCount,
          content: "",
          suggestedContent: "",
        };
        hunkLines = [];
      }
      continue;
    }

    // Hunk content
    if (currentHunk) {
      hunkLines.push(line);
    }
  }

  // Don't forget the last hunk
  if (currentFile && currentHunk) {
    currentHunk.content = hunkLines.join("\n");
    currentHunk.suggestedContent = extractSuggestedContent(hunkLines);
    currentFile.hunks.push(currentHunk);
  }

  return changes;
}

/**
 * Extract the suggested content from a diff hunk
 * (removes diff markers and shows only the new content)
 */
function extractSuggestedContent(hunkLines: string[]): string {
  const newLines: string[] = [];

  for (const line of hunkLines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      // Add lines (remove the + prefix)
      newLines.push(line.substring(1));
    } else if (line.startsWith(" ")) {
      // Context lines (keep as-is, remove space prefix)
      newLines.push(line.substring(1));
    }
    // Skip removed lines (-)
  }

  return newLines.join("\n");
}

/**
 * Create review comments from file changes
 */
export function createReviewComments(
  changes: FileChange[],
  reasoning: string,
): ReviewComment[] {
  const comments: ReviewComment[] = [];

  for (const change of changes) {
    for (const hunk of change.hunks) {
      const body = `**Suggested fix:**

\`\`\`suggestion
${hunk.suggestedContent}
\`\`\`

${reasoning}`;

      comments.push({
        path: change.path,
        line: hunk.startLine + hunk.lineCount - 1, // Comment on the last line of the hunk
        body,
      });
    }
  }

  return comments;
}

/**
 * Post review comments on a GitHub PR
 */
export async function postReviewComments(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  comments: ReviewComment[],
  commitSha: string,
): Promise<void> {
  if (comments.length === 0) {
    console.log("No review comments to post");
    return;
  }

  console.log(`Posting ${comments.length} review comment(s) to PR #${pullNumber}`);

  // Create a review with all comments
  await octokit.pulls.createReview({
    owner,
    repo,
    pull_number: pullNumber,
    commit_id: commitSha,
    event: "COMMENT",
    comments: comments.map((comment) => ({
      path: comment.path,
      line: comment.line,
      body: comment.body,
    })),
  });

  console.log("Review comments posted successfully");
}
