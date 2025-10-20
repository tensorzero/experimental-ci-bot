/**
 * CLI adapter - converts CLI options into AgentRunnerInput
 */
import { Octokit } from '@octokit/rest'
import { execSync } from 'child_process'
import type { CliOptions } from '../cli/args.js'
import type {
  AgentRunnerInput,
  PullRequestInfo,
  CIFailureInfo
} from '../core/types.js'
import type { WorkflowJobsResponse } from '../generate-pr-patch/types.js'
import type { FailedJobSummary } from '../tensorZeroClient.js'
import {
  getFailedWorkflowRunLogs,
  findLatestFailedWorkflowRun
} from '../pullRequests.js'

/**
 * Get GitHub token from CLI options, environment, or gh CLI
 */
function getGitHubToken(options: CliOptions): string {
  // Priority: CLI option > GITHUB_TOKEN env > gh CLI
  if (options.token) {
    return options.token
  }

  if (process.env.GITHUB_TOKEN) {
    return process.env.GITHUB_TOKEN
  }

  // Try to get token from gh CLI
  try {
    const token = execSync('gh auth token', { encoding: 'utf-8' }).trim()
    if (token) {
      console.log('[CLI Adapter] Using token from gh CLI')
      return token
    }
  } catch (error) {
    // gh CLI not available or not authenticated
  }

  throw new Error(
    'GitHub token not found. Please provide via --token, GITHUB_TOKEN env var, or authenticate with gh CLI (gh auth login)'
  )
}

/**
 * Fetch PR information from GitHub API
 */
async function fetchPullRequestInfo(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequestInfo> {
  console.log(`[CLI Adapter] Fetching PR #${prNumber} from ${owner}/${repo}...`)

  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber
  })

  return {
    owner,
    repo,
    number: prNumber,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    htmlUrl: pr.html_url,
    description: pr.body
  }
}

/**
 * Fetch workflow job status
 */
async function getJobStatus(
  jobsUrl: string,
  token: string
): Promise<WorkflowJobsResponse> {
  const response = await fetch(jobsUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  })

  if (!response.ok) {
    throw new Error(
      `Failed to fetch workflow jobs from ${jobsUrl}: ${response.status} ${response.statusText}`
    )
  }

  return (await response.json()) as WorkflowJobsResponse
}

/**
 * Get all failed jobs from workflow
 */
function getAllFailedJobs(
  workflowJobsStatus: WorkflowJobsResponse
): FailedJobSummary[] {
  return (workflowJobsStatus.jobs ?? [])
    .filter((job) => job.conclusion !== 'success')
    .map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      html_url: job.html_url,
      failed_steps: (job.steps ?? [])
        .filter((step) => step.conclusion && step.conclusion !== 'success')
        .map((step) => ({
          name: step.name,
          status: step.status,
          conclusion: step.conclusion
        }))
    }))
}

/**
 * Fetch CI failure information for a specific workflow run
 */
async function fetchCIFailureInfo(
  octokit: Octokit,
  owner: string,
  repo: string,
  workflowRunId: number,
  token: string
): Promise<CIFailureInfo | undefined> {
  console.log(`[CLI Adapter] Fetching workflow run #${workflowRunId}...`)

  try {
    const { data: workflowRun } = await octokit.rest.actions.getWorkflowRun({
      owner,
      repo,
      run_id: workflowRunId
    })

    if (workflowRun.conclusion !== 'failure') {
      console.log(
        `[CLI Adapter] Warning: Workflow run #${workflowRunId} did not fail (conclusion: ${workflowRun.conclusion})`
      )
      return undefined
    }

    // Fetch jobs
    const jobsUrl = workflowRun.jobs_url
    const workflowJobsStatus = await getJobStatus(jobsUrl, token)
    const failedJobs = getAllFailedJobs(workflowJobsStatus)

    // Fetch failure logs
    const failureLogs = await getFailedWorkflowRunLogs(
      workflowRunId,
      owner,
      repo
    )

    return {
      workflowRunId,
      workflowRunUrl: workflowRun.html_url,
      failedJobs,
      failureLogs
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : `${error}`
    console.error(
      `[CLI Adapter] Failed to fetch CI failure info: ${errorMessage}`
    )
    return undefined
  }
}

/**
 * Convert CLI options to AgentRunnerInput
 */
export async function createAgentInputFromCli(
  options: CliOptions
): Promise<AgentRunnerInput> {
  // Get GitHub token
  const token = getGitHubToken(options)

  // Create Octokit instance
  const octokit = new Octokit({ auth: token })

  // Parse repository
  const [owner, repo] = options.repository.split('/')

  // Fetch PR information
  const pullRequest = await fetchPullRequestInfo(
    octokit,
    owner,
    repo,
    options.pr
  )

  // Fetch CI failure information
  let ciFailure: CIFailureInfo | undefined
  let workflowRunId = options.workflowRunId

  // Auto-detect workflow run if not provided
  if (!workflowRunId) {
    console.log(
      '[CLI Adapter] No workflow run ID provided, searching for latest failed run...'
    )
    console.log(
      `[CLI Adapter] Searching for failed workflow runs for commit ${pullRequest.headSha.substring(0, 7)}...`
    )
    workflowRunId = await findLatestFailedWorkflowRun(
      octokit as any,
      owner,
      repo,
      pullRequest.headSha
    )

    if (workflowRunId) {
      console.log(`[CLI Adapter] Found failed workflow run #${workflowRunId}`)
    } else {
      console.log(
        '[CLI Adapter] No failed workflow runs found. Agent will run without CI failure context.'
      )
    }
  }

  // Fetch CI failure details if we have a workflow run ID
  if (workflowRunId) {
    ciFailure = await fetchCIFailureInfo(
      octokit,
      owner,
      repo,
      workflowRunId,
      token
    )
  }

  // Build ClickHouse config if provided
  const clickhouse =
    options.clickhouseUrl && options.clickhouseTable
      ? {
          url: options.clickhouseUrl,
          table: options.clickhouseTable
        }
      : undefined

  return {
    octokit: octokit as any, // Type compatibility
    token,
    pullRequest,
    ciFailure,
    mode: options.dryRun ? 'dry-run' : 'live',
    outputDir: options.outputDir,
    clickhouse,
    agent: {
      costLimit: options.costLimit ?? 3.0,
      timeout: options.timeout ?? 30
    }
  }
}
