import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'
import * as path from 'path'

import {
  extractCommentsFromLlmResponse,
  extractDiffFromLlmResponse,
  extractXmlTagFromLlmResponse
} from './llmResponse.js'
import {
  type WorkflowJobsResponse,
  type FollowupPrResult,
  type GeneratePrPatchActionInput,
  OctokitInstance
} from './types.js'
import {
  type CreatePullRequestToInferenceRequest,
  createPullRequestToInferenceRecord
} from '../clickhouseClient.js'
import {
  createFollowupPr,
  getPullRequestDiff,
  getFailedWorkflowRunLogs
} from '../gitClient.js'
import {
  callTensorZeroOpenAi,
  provideInferenceFeedback,
  type TensorZeroGenerationArguments,
  type FailedJobSummary
} from '../tensorZeroClient.js'
import { renderComment } from './pullRequestCommentTemplate.js'

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
): Promise<{ diffSummary: string; fullDiff: string }> {
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
    fullDiff: diffResult.fullDiff
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

/**
 * Collects artifacts, builds a prompt to an LLM, then
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  const inputs = parseAndValidateActionInputs()
  const {
    token,
    tensorZeroBaseUrl,
    tensorZeroDiffPatchedSuccessfullyMetricName,
    outputArtifactsDir,
    clickhouse
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

  // Fetching jobs from the workflow run to get what steps failed
  const jobsUrl = workflow_run_payload.jobs_url
  if (!jobsUrl) {
    throw new Error('Missing jobs_url from workflow_run')
  }
  core.info(`Fetching jobs from: ${jobsUrl}`)
  const workflowJobsStatus = await getJobStatus(jobsUrl, token)

  maybeWriteDebugArtifact(
    outputDir,
    'workflow-jobs.json',
    JSON.stringify(workflowJobsStatus, null, 2)
  )

  const { owner, repo } = github.context.repo
  const octokit = github.getOctokit(token)
  const pullRequest = workflow_run_payload.pull_requests?.[0]
  const prNumber = workflow_run_payload.pull_requests?.[0]?.number

  // Load diff summary and full diff.
  const { diffSummary, fullDiff } = await fetchDiffSummaryAndFullDiff(
    octokit,
    owner,
    repo,
    prNumber,
    token
  )
  maybeWriteDebugArtifact(outputDir, 'fetched-diff-summary.txt', diffSummary)
  maybeWriteDebugArtifact(outputDir, 'fetched-full-diff.txt', fullDiff)

  const failedJobs: FailedJobSummary[] = getAllFailedJobs(workflowJobsStatus)

  // Gather failure logs
  const failureLogs = await getFailedWorkflowRunLogs(runId)

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
  maybeWriteDebugArtifact(
    outputDir,
    'llm-response.json',
    JSON.stringify(response, null, 2)
  )
  maybeWriteDebugArtifact(outputDir, 'failure-logs.txt', failureLogs)

  // Get the LLM response from `response`
  const llmResponse = response.choices[0].message.content
  if (!llmResponse) {
    throw new Error('No LLM response found, failing the action.')
  }

  // We take the first non-empty diff and comments, but output all commands.
  const comments = extractXmlTagFromLlmResponse(llmResponse, 'comments')
  const diff = extractXmlTagFromLlmResponse(llmResponse, 'diff')

  const command = extractXmlTagFromLlmResponse(llmResponse, 'command')

  if (!comments && !diff && !command) {
    core.info(
      'LLM response contains no comments, diff, or command; finishing without changes.'
    )
    return
  }

  if (!prNumber) {
    core.warning(
      'Unable to identify the original pull request; skipping comment and follow-up PR creation.'
    )
    return
  }

  if (!pullRequest) {
    core.warning(
      'Unable to load pull request details; skipping follow-up PR creation.'
    )
    return
  }

  const trimmedDiff = diff[0].trim()
  let followupPr: FollowupPrResult | undefined
  let followupPrCreationError: string | undefined
  if (trimmedDiff) {
    try {
      followupPr = await createFollowupPr(
        {
          octokit,
          token,
          owner,
          repo,
          pullRequest,
          diff: trimmedDiff
        },
        outputDir
      )
      if (followupPr) {
        await provideInferenceFeedback(
          tensorZeroBaseUrl,
          tensorZeroDiffPatchedSuccessfullyMetricName,
          response.id,
          true
        )
      }
    } catch (error) {
      await provideInferenceFeedback(
        tensorZeroBaseUrl,
        tensorZeroDiffPatchedSuccessfullyMetricName,
        response.id,
        false,
        { reason: 'Failed to Apply Patch' }
      )

      followupPrCreationError =
        error instanceof Error ? error.message : `${error}`
      core.error(followupPrCreationError)
    }
  }

  // TODO: consider using episode_id instead of inference ID.
  const inferenceId = response.id

  if (followupPr) {
    const request: CreatePullRequestToInferenceRequest = {
      inferenceId,
      pullRequestId: followupPr.id,
      originalPullRequestUrl: pullRequest.html_url
    }
    try {
      await createPullRequestToInferenceRecord(request, clickhouse)
      core.info(
        `Recorded inference ${inferenceId} for follow-up PR #${followupPr.number} (id ${followupPr.id}) in ClickHouse.`
      )
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${error}`
      core.warning(
        `Failed to record inference ${inferenceId} for follow-up PR #${followupPr.number} (id ${followupPr.id}) in ClickHouse: ${errorMessage}`
      )
    }
  }

  const trimmedComments = comments[0].trim()
  const comment = renderComment({
    generatedCommentBody: trimmedComments,
    generatedPatch: trimmedDiff,
    commands,
    followupPrNumber: followupPr?.number,
    followupPrCreationError
  })
  if (comment) {
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: prNumber,
        body: comment
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${error}`
      core.warning(
        `Failed to create comment on pull request #${prNumber}: ${errorMessage}`
      )
      // Don't throw here - commenting is not critical to the main functionality
    }
  }
}
