import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'
import * as path from 'path'
import * as fsPromises from 'fs/promises'
import * as os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'

import { extractXmlTagsFromLlmResponse } from './llmResponse.js'
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
  getFailedWorkflowRunLogs,
  type PullRequestData
} from '../gitClient.js'
import {
  provideInferenceFeedback,
  type FailedJobSummary
} from '../tensorZeroClient.js'
import { renderComment } from './pullRequestCommentTemplate.js'
import { runMiniSweAgent } from '../miniSweAgentClient.js'
import {
  writeCIFailureContextFile,
  type CIFailureContext
} from './ciFailureContext.js'
import {
  parseGitDiff,
  createReviewComments,
  postReviewComments
} from '../githubReviewComments.js'

const execFileAsync = promisify(execFile)

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

function maskSecret(value: string, secret: string | undefined): string {
  if (!secret || !value) {
    return value
  }
  return value.split(secret).join('***')
}

async function execGit(
  args: string[],
  options: { cwd?: string; token?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  const { cwd, token } = options
  const commandString = maskSecret(`git ${args.join(' ')}`, token)
  core.info(commandString)
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      },
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'utf-8'
    })
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? ''
    }
  } catch (error) {
    const err = error as { message: string; stdout?: string; stderr?: string }
    const stderr = err.stderr || err.stdout || err.message
    throw new Error(`${commandString} failed: ${maskSecret(stderr, token)}`)
  }
}

interface ClonedRepository {
  repoDir: string
  cleanup: () => Promise<void>
}

async function clonePullRequestRepository(
  token: string,
  owner: string,
  repo: string,
  pullRequest: PullRequestData
): Promise<ClonedRepository> {
  const tempBaseDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'tensorzero-pr-')
  )
  const repoDir = path.join(tempBaseDir, 'repo')
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`

  try {
    await execGit(
      [
        'clone',
        '--origin',
        'origin',
        '--branch',
        pullRequest.head.ref,
        remoteUrl,
        repoDir
      ],
      { token }
    )
  } catch (error) {
    await fsPromises.rm(tempBaseDir, { recursive: true, force: true })
    throw error
  }

  const cleanup = async (): Promise<void> => {
    await fsPromises.rm(tempBaseDir, { recursive: true, force: true })
  }

  return { repoDir, cleanup }
}

/**
 * Collects artifacts, runs mini-swe-agent to fix CI failures, then posts
 * inline suggestions or creates a follow-up PR based on the agent's decision.
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

  if (!prNumber || !pullRequest) {
    core.warning(
      'Unable to identify the pull request; skipping action.'
    )
    return
  }

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
  maybeWriteDebugArtifact(outputDir, 'failure-logs.txt', failureLogs)

  // Clone the PR repository
  core.info('Cloning pull request repository...')
  const { repoDir, cleanup } = await clonePullRequestRepository(
    token,
    owner,
    repo,
    pullRequest
  )

  try {
    // Write CI failure context file
    const ciContext: CIFailureContext = {
      repoFullName: `${owner}/${repo}`,
      branch: workflow_run_payload.head_branch,
      prNumber,
      workflowRunId: runId,
      workflowRunUrl: workflow_run_payload.html_url,
      prUrl: pullRequest.html_url,
      failedJobs,
      diffSummary,
      fullDiff,
      failureLogs
    }

    const contextFilePath = writeCIFailureContextFile(repoDir, ciContext)
    core.info(`CI failure context written to: ${contextFilePath}`)

    // Prepare TensorZero config path
    const tensorZeroConfigPath = path.join(
      process.cwd(),
      'tensorzero',
      'swe_agent_config'
    )

    // Run mini-swe-agent
    core.info('Running mini-swe-agent...')
    const agentResult = await runMiniSweAgent({
      task: 'Fix the CI failures as described in ci_failure_context.md',
      cwd: repoDir,
      tensorZeroConfigPath,
      trajectoryOutputPath: outputDir
        ? path.join(outputDir, 'agent_trajectory.json')
        : path.join(repoDir, 'agent_trajectory.json'),
      costLimit: 3.0,
      timeout: 30 * 60 * 1000 // 30 minutes
    })

    core.info(`Agent completed with decision: ${agentResult.completion.decision}`)
    core.info(`Agent reasoning: ${agentResult.completion.reasoning}`)

    // Save agent trajectory as debug artifact
    if (outputDir) {
      maybeWriteDebugArtifact(
        outputDir,
        'agent_trajectory.json',
        JSON.stringify(agentResult.trajectory, null, 2)
      )
    }

    // Handle the agent's decision
    if (agentResult.completion.decision === 'INLINE_SUGGESTIONS') {
      core.info('Agent chose to provide inline suggestions')

      // Parse the git diff to extract changes
      const fileChanges = await parseGitDiff(repoDir)

      if (fileChanges.length === 0) {
        core.info('No file changes detected; skipping review comments.')
      } else {
        // Create review comments
        const reviewComments = createReviewComments(
          fileChanges,
          agentResult.completion.reasoning
        )

        // Post review comments to GitHub
        await postReviewComments(
          octokit,
          owner,
          repo,
          prNumber,
          reviewComments,
          pullRequest.head.sha
        )

        core.info(`Posted ${reviewComments.length} inline suggestion(s) to PR #${prNumber}`)

        // TODO: Track feedback metric for suggestions
        // We'll implement this in the feedback collection workflow
      }
    } else {
      // PULL_REQUEST decision
      core.info('Agent chose to create a follow-up PR')

      // Get the git diff as a patch
      const { stdout: diffOutput } = await execGit(['diff'], {
        cwd: repoDir,
        token
      })

      const trimmedDiff = diffOutput.trim()

      if (!trimmedDiff) {
        core.info('No changes detected; skipping follow-up PR creation.')
      } else {
        // Create follow-up PR using existing logic
        let followupPr: FollowupPrResult | undefined
        let followupPrCreationError: string | undefined

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
            core.info(`Created follow-up PR #${followupPr.number}`)

            // Record inference in ClickHouse
            // Note: We don't have an inference ID from mini-swe-agent, so we'll use the trajectory's result as ID
            const inferenceId = `agent-${runId}-${Date.now()}`

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
                `Failed to record inference ${inferenceId} for follow-up PR #${followupPr.number} in ClickHouse: ${errorMessage}`
              )
            }
          }
        } catch (error) {
          followupPrCreationError =
            error instanceof Error ? error.message : `${error}`
          core.error(`Failed to create follow-up PR: ${followupPrCreationError}`)
        }

        // Post a comment on the original PR
        const comment = renderComment({
          generatedCommentBody: agentResult.completion.reasoning,
          generatedPatch: trimmedDiff,
          commands: [],
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
          }
        }
      }
    }
  } finally {
    // Clean up cloned repository
    await cleanup()
    core.info('Cleaned up temporary repository')
  }
}
