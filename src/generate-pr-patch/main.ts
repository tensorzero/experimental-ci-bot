import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'
import * as path from 'path'

import { extractXmlTagsFromLlmResponse } from './llmResponse.js'
import {
  type WorkflowJobsResponse,
  type GeneratePrPatchActionInput,
  type PullRequestData,
  OctokitInstance
} from './types.js'
import { getPullRequestDiff, getFailedWorkflowRunLogs } from '../gitClient.js'
import {
  callTensorZeroOpenAi,
  type TensorZeroGenerationArguments,
  type FailedJobSummary
} from '../tensorZeroClient.js'
import { writePatchArtifacts } from './artifactWriter.js'
import {
  PATCH_MANIFEST_SCHEMA_VERSION,
  type PullRequestPatchManifest
} from '../artifacts/pullRequestPatchManifest.js'

async function getJobStatus(
  jobsUrl: string,
  token: string
): Promise<WorkflowJobsResponse> {
  // Fetch jobs from the workflow run
  let jobsResponse: Response
  try {
    jobsResponse = await fetch(jobsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : `${error}`
    throw new Error(
      `Failed to fetch workflow jobs from ${jobsUrl}: ${errorMessage}`
    )
  }

  if (jobsResponse.ok) {
    try {
      return (await jobsResponse.json()) as WorkflowJobsResponse
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${error}`
      throw new Error(
        `Failed to parse workflow jobs JSON response: ${errorMessage}`
      )
    }
  }

  // Provide more context about the error
  let errorBody = ''
  try {
    errorBody = await jobsResponse.text()
  } catch {
    // Ignore error when trying to read error body
  }

  throw new Error(
    `Failed to load workflow jobs from ${jobsUrl}: ${jobsResponse.status} ${jobsResponse.statusText}${errorBody ? ` - ${errorBody}` : ''}`
  )
}

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

// Parse action inputs
function parseAndValidateActionInputs(): GeneratePrPatchActionInput {
  const token = core.getInput('token')?.trim()
  if (!token) {
    throw new Error(
      'A GitHub token is required. Provide one via the `token` input.'
    )
  }
  const tensorZeroBaseUrl = core.getInput('tensorzero-base-url')?.trim()
  if (!tensorZeroBaseUrl) {
    throw new Error(
      'TensorZero base url is required; provide one via the `tensorzero-base-url` input.'
    )
  }
  const tensorZeroDiffPatchedSuccessfullyMetricName = core
    .getInput('tensorzero-diff-patched-successfully-metric-name')
    ?.trim()
  if (!tensorZeroDiffPatchedSuccessfullyMetricName) {
    throw new Error(
      'TensorZero metric name is required; provide one via the `tensorzero-diff-patched-successfully-metric-name` input.'
    )
  }

  const outputArtifactsDirInput = core.getInput('output-artifacts-dir')
  const outputArtifactsDir = outputArtifactsDirInput
    ? outputArtifactsDirInput.trim() || undefined
    : undefined

  const clickhouseUrl = core.getInput('clickhouse-url')?.trim()
  if (!clickhouseUrl) {
    throw new Error(
      'ClickHouse URL is required when configuring ClickHouse logging; provide one via the `clickhouse-url` input.'
    )
  }

  const clickhouseTable = core.getInput('clickhouse-table')?.trim()
  if (!clickhouseTable) {
    throw new Error(
      'ClickHouse table name is required when configuring ClickHouse logging; provide one via the `clickhouse-table` input.'
    )
  }

  return {
    token,
    tensorZeroBaseUrl,
    tensorZeroDiffPatchedSuccessfullyMetricName,
    outputArtifactsDir,
    clickhouse: {
      url: clickhouseUrl,
      table: clickhouseTable
    }
  }
}

async function fetchDiffSummaryAndFullDiff(
  octokit: OctokitInstance,
  owner: string,
  repo: string,
  prNumber: number,
  token: string
): Promise<{
  diffSummary: string
  fullDiff: string
  pullRequest: PullRequestData
}> {
  if (!prNumber) {
    throw new Error(
      'Unable to determine pull request number to compute diff contents.'
    )
  }
  core.info('Diff inputs not provided; computing PR diff via git.')
  const prResponse = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber
  })
  const pullRequest = prResponse.data
  const diffResult = await getPullRequestDiff({
    token,
    owner,
    repo,
    pullRequest
  })

  return {
    diffSummary: diffResult.diffSummary,
    fullDiff: diffResult.fullDiff,
    pullRequest
  }
}

function maybeWriteDebugArtifact(
  outputDir: string | undefined,
  filename: string,
  content: string
) {
  if (!outputDir) {
    return
  }
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  fs.writeFileSync(path.join(outputDir, filename), content, {
    encoding: 'utf-8'
  })
  core.info(`${filename} written to ${path.join(outputDir, filename)}`)
}

function validatePullRequestForManifest(pullRequest: PullRequestData): void {
  if (!pullRequest.head?.sha) {
    throw new Error('Pull request head SHA is missing from API response.')
  }
  if (!pullRequest.base?.sha) {
    throw new Error('Pull request base SHA is missing from API response.')
  }
}

/**
 * Collects artifacts, builds a prompt to an LLM, then stores untrusted outputs
 * for a privileged workflow to consume.
 */
export async function run(): Promise<void> {
  const inputs = parseAndValidateActionInputs()
  const {
    token,
    tensorZeroBaseUrl,
    tensorZeroDiffPatchedSuccessfullyMetricName,
    outputArtifactsDir
  } = inputs

  // Prepare artifact directory
  const outputDir = outputArtifactsDir
    ? path.join(process.cwd(), outputArtifactsDir)
    : undefined
  if (outputDir) {
    core.info(`Output artifact directory: ${outputDir}`)
  } else {
    core.warning(`Not creating output artifacts.`)
  }

  if (!isPullRequestEligibleForFix()) {
    core.warning(`Pull request is not eligible for fix. Skipping action.`)
    return
  }

  const workflow_run_payload = github.context.payload['workflow_run']
  const runId = workflow_run_payload.id
  if (!runId) {
    throw new Error('Unable to determine target workflow run.')
  }
  core.info(`Target workflow run ID: ${runId}`)
  if (workflow_run_payload.conclusion !== 'failure') {
    core.warning(`Workflow run did not fail. Skipping action.`)
    return
  }

  const prNumber = workflow_run_payload.pull_requests?.[0]?.number
  if (!prNumber) {
    throw new Error(
      'Unable to determine pull request number from workflow run.'
    )
  }

  const artifactOutputs: PullRequestPatchManifest['outputs'] = {}

  // Fetching jobs from the workflow run to get what steps failed
  const jobsUrl = workflow_run_payload.jobs_url
  if (!jobsUrl) {
    throw new Error('Missing jobs_url from workflow_run')
  }
  core.info(`Fetching jobs from: ${jobsUrl}`)
  const workflowJobsStatus = await getJobStatus(jobsUrl, token)

  if (outputDir) {
    maybeWriteDebugArtifact(
      outputDir,
      'workflow-jobs.json',
      JSON.stringify(workflowJobsStatus, null, 2)
    )
    artifactOutputs.workflowJobsPath = 'workflow-jobs.json'
  }

  const { owner, repo } = github.context.repo
  const octokit = github.getOctokit(token)

  // Load diff summary, full diff, and authoritative pull request details.
  const { diffSummary, fullDiff, pullRequest } =
    await fetchDiffSummaryAndFullDiff(octokit, owner, repo, prNumber, token)
  validatePullRequestForManifest(pullRequest)

  if (outputDir) {
    maybeWriteDebugArtifact(outputDir, 'fetched-diff-summary.txt', diffSummary)
    maybeWriteDebugArtifact(outputDir, 'fetched-full-diff.txt', fullDiff)
  }

  const failedJobs: FailedJobSummary[] = getAllFailedJobs(workflowJobsStatus)

  // Gather failure logs
  const failureLogs = await getFailedWorkflowRunLogs(runId)
  if (outputDir) {
    maybeWriteDebugArtifact(outputDir, 'failure-logs.txt', failureLogs)
    artifactOutputs.failureLogsPath = 'failure-logs.txt'
  }

  // Call TensorZero to generate a PR and comment.
  const generationArguments: TensorZeroGenerationArguments = {
    failed_jobs: failedJobs,
    diff_summary: diffSummary,
    full_diff: fullDiff,
    failure_logs: failureLogs,
    repo_full_name: `${owner}/${repo}`,
    branch: workflow_run_payload.head_branch,
    pr_number: prNumber
  }

  const response = await callTensorZeroOpenAi(
    tensorZeroBaseUrl,
    generationArguments
  )
  if (outputDir) {
    maybeWriteDebugArtifact(
      outputDir,
      'llm-response.json',
      JSON.stringify(response, null, 2)
    )
    artifactOutputs.llmResponsePath = 'llm-response.json'
  }

  // Get the LLM response from `response`
  const llmResponse = response.choices[0].message.content
  if (!llmResponse) {
    throw new Error('No LLM response found, failing the action.')
  }

  // We take the first non-empty diff and comments, but output all commands.
  const comments = extractXmlTagsFromLlmResponse(llmResponse, 'comments')
  const diff = extractXmlTagsFromLlmResponse(llmResponse, 'diff')
  const commands = extractXmlTagsFromLlmResponse(llmResponse, 'command')

  const trimmedDiff = diff[0]?.trim() ?? ''
  const trimmedComments = comments[0]?.trim() ?? ''
  const filteredCommands = commands.filter(
    (command) => command.trim().length > 0
  )

  const manifest: PullRequestPatchManifest = {
    schemaVersion: PATCH_MANIFEST_SCHEMA_VERSION,
    artifactVersion: '1.0.0',
    createdAt: new Date().toISOString(),
    workflowRun: {
      id: runId,
      attempt: workflow_run_payload.run_attempt,
      name: workflow_run_payload.name,
      headBranch: workflow_run_payload.head_branch
    },
    repository: {
      owner,
      name: repo
    },
    pullRequest: {
      number: prNumber,
      headSha: pullRequest.head.sha,
      headRef: pullRequest.head.ref,
      baseSha: pullRequest.base.sha,
      baseRef: pullRequest.base.ref,
      htmlUrl: pullRequest.html_url,
      headRepositoryId: pullRequest.head.repo?.id,
      baseRepositoryId: pullRequest.base.repo?.id,
      author: {
        login: pullRequest.user?.login,
        id: pullRequest.user?.id
      }
    },
    outputs: artifactOutputs,
    llm: {
      inferenceId: response.id,
      responseId: response.id,
      episodeId: response.episode_id
    },
    tensorZero: {
      diffPatchedMetricName: tensorZeroDiffPatchedSuccessfullyMetricName
    },
    metadata: {
      hasDiff: trimmedDiff.length > 0,
      hasComment: trimmedComments.length > 0,
      hasCommands: filteredCommands.length > 0
    }
  }

  writePatchArtifacts({
    outputDir,
    manifest,
    diff: trimmedDiff,
    generatedCommentBody: trimmedComments,
    commands: filteredCommands
  })

  if (
    !manifest.metadata.hasDiff &&
    !manifest.metadata.hasComment &&
    !manifest.metadata.hasCommands
  ) {
    core.info(
      'LLM response contains no comments, diff, or command; finishing without changes.'
    )
    return
  }

  core.info('Generated artifacts for privileged workflow consumption.')
}
