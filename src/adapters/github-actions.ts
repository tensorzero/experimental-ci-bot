/**
 * GitHub Actions adapter - extracts context and converts to AgentRunnerInput
 */
import * as core from '@actions/core'
import * as github from '@actions/github'
import type { AgentRunnerInput, PullRequestInfo, CIFailureInfo } from '../core/types.js'
import type { WorkflowJobsResponse } from '../generate-pr-patch/types.js'
import type { FailedJobSummary } from '../tensorZeroClient.js'
import { getFailedWorkflowRunLogs } from '../pullRequests.js'

/**
 * Parse action inputs from GitHub Actions environment
 */
interface ActionInputs {
  token: string
  tensorZeroBaseUrl?: string
  tensorZeroDiffPatchedSuccessfullyMetricName?: string
  outputArtifactsDir?: string
  clickhouse?: {
    url: string
    table: string
  }
}

function parseActionInputs(): ActionInputs {
  const token = core.getInput('token')?.trim()
  if (!token) {
    throw new Error(
      'A GitHub token is required. Provide one via the `token` input.'
    )
  }

  const tensorZeroBaseUrl = core.getInput('tensorzero-base-url')?.trim()
  const tensorZeroDiffPatchedSuccessfullyMetricName = core
    .getInput('tensorzero-diff-patched-successfully-metric-name')
    ?.trim()

  const outputArtifactsDirInput = core.getInput('output-artifacts-dir')
  const outputArtifactsDir = outputArtifactsDirInput
    ? outputArtifactsDirInput.trim() || undefined
    : undefined

  const clickhouseUrl = core.getInput('clickhouse-url')?.trim()
  const clickhouseTable = core.getInput('clickhouse-table')?.trim()

  const clickhouse =
    clickhouseUrl && clickhouseTable
      ? { url: clickhouseUrl, table: clickhouseTable }
      : undefined

  return {
    token,
    tensorZeroBaseUrl,
    tensorZeroDiffPatchedSuccessfullyMetricName,
    outputArtifactsDir,
    clickhouse
  }
}

/**
 * Check if PR is eligible for fix
 */
function isPullRequestEligibleForFix(): boolean {
  // If the workflow run is not associated with a single pull request, we don't want to fix it.
  if (github.context.payload.workflow_run?.pull_requests?.length !== 1) {
    core.warning(
      `Workflow run is not associated with a single pull request; skipping action.`
    )
    return false
  }

  const pullRequest = github.context.payload.workflow_run.pull_requests[0]
  if (!pullRequest) {
    core.warning(
      `Workflow run is not associated with a pull request; skipping action.`
    )
    return false
  }

  // If the pull request originates from a fork, we don't want to fix it.
  if (pullRequest.head.repo?.id !== pullRequest.base.repo?.id) {
    core.warning(
      `PR originates from a fork: base repo is ${pullRequest.base.repo?.name}, but PR branch is from ${pullRequest.head.repo?.name}; skipping action.`
    )
    return false
  }

  // If the workflow run did not fail, we don't want to fix it.
  if (github.context.payload.workflow_run.conclusion !== 'failure') {
    core.warning(
      `Workflow run did not fail (conclusion ${github.context.payload.workflow_run.conclusion}); skipping action.`
    )
    return false
  }

  // If the pull request is not targeting the main branch, we don't want to fix it.
  if (
    pullRequest.base?.ref !== github.context.payload.repository?.default_branch
  ) {
    core.warning(
      `PR is not targeting the main branch: PR branch is ${pullRequest.base?.ref}, but main branch is ${github.context.payload.repository?.default_branch}; skipping action.`
    )
    return false
  }

  core.info(`PR is eligible for fix.`)
  return true
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
    let errorBody = ''
    try {
      errorBody = await response.text()
    } catch {
      // Ignore error when reading error body
    }

    throw new Error(
      `Failed to load workflow jobs from ${jobsUrl}: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`
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
 * Extract PR information from GitHub Actions context
 */
async function extractPullRequestInfo(
  octokit: any,
  owner: string,
  repo: string
): Promise<PullRequestInfo | null> {
  const workflow_run_payload = github.context.payload['workflow_run']
  const pullRequest = workflow_run_payload.pull_requests?.[0]

  if (!pullRequest) {
    return null
  }

  // Fetch full PR details to get description
  const prResponse = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: pullRequest.number
  })

  return {
    owner,
    repo,
    number: pullRequest.number,
    headSha: workflow_run_payload.head_sha,
    headRef: workflow_run_payload.head_branch,
    baseRef: pullRequest.base?.ref,
    htmlUrl: pullRequest.html_url,
    description: prResponse.data.body
  }
}

/**
 * Extract CI failure information from GitHub Actions context
 */
async function extractCIFailureInfo(
  token: string
): Promise<CIFailureInfo | null> {
  const workflow_run_payload = github.context.payload['workflow_run']
  const runId = workflow_run_payload.id

  if (!runId) {
    return null
  }

  if (workflow_run_payload.conclusion !== 'failure') {
    return null
  }

  // Fetch jobs from the workflow run
  const jobsUrl = workflow_run_payload.jobs_url
  if (!jobsUrl) {
    throw new Error('Missing jobs_url from workflow_run')
  }

  core.info(`Fetching jobs from: ${jobsUrl}`)
  const workflowJobsStatus = await getJobStatus(jobsUrl, token)
  const failedJobs = getAllFailedJobs(workflowJobsStatus)

  // Gather failure logs
  const failureLogs = await getFailedWorkflowRunLogs(runId)

  return {
    workflowRunId: runId,
    workflowRunUrl: workflow_run_payload.html_url,
    failedJobs,
    failureLogs
  }
}

/**
 * Create AgentRunnerInput from GitHub Actions context
 */
export async function createAgentInputFromGitHubActions(): Promise<AgentRunnerInput | null> {
  // Check if PR is eligible
  if (!isPullRequestEligibleForFix()) {
    core.warning(`Pull request is not eligible for fix. Skipping action.`)
    return null
  }

  // Parse action inputs
  const inputs = parseActionInputs()
  const { token, outputArtifactsDir, clickhouse, tensorZeroBaseUrl, tensorZeroDiffPatchedSuccessfullyMetricName } = inputs

  // Mask the token
  core.setSecret(token)

  // Get repo info
  const { owner, repo } = github.context.repo
  const octokit = github.getOctokit(token)

  // Extract PR information
  const pullRequest = await extractPullRequestInfo(octokit, owner, repo)
  if (!pullRequest) {
    core.warning('Unable to identify the pull request; skipping action.')
    return null
  }

  // Extract CI failure information
  const ciFailure = await extractCIFailureInfo(token)
  if (!ciFailure) {
    core.warning('No CI failure information available; skipping action.')
    return null
  }

  return {
    octokit: octokit as any,
    token,
    pullRequest,
    ciFailure,
    mode: 'live', // GitHub Actions always runs in live mode
    outputDir: outputArtifactsDir,
    clickhouse,
    tensorZero: {
      baseUrl: tensorZeroBaseUrl,
      diffPatchedSuccessfullyMetricName: tensorZeroDiffPatchedSuccessfullyMetricName
    },
    agent: {
      costLimit: 3.0, // Default for GitHub Actions
      timeout: 30 // 30 minutes
    }
  }
}
