/**
 * Core agent runner logic shared between GitHub Actions and CLI
 */
import * as fs from 'fs'
import * as path from 'path'
import type {
  AgentRunnerInput,
  AgentRunnerResult,
  PullRequestInfo
} from './types.js'
import type { OctokitInstance } from '../generate-pr-patch/types.js'
import { createFollowupPr, type FollowupPrResult } from '../pullRequests.js'
import { runMiniSweAgent } from '../miniSweAgentClient.js'
import {
  writeCIFailureContextFile,
  type CIFailureContext
} from '../generate-pr-patch/ciFailureContext.js'
import {
  parseGitDiff,
  createReviewComments,
  postReviewComments
} from '../githubReviewComments.js'
import { clonePullRequestRepository, getPullRequestDiff } from '../git.js'
import {
  type CreatePullRequestToInferenceRequest,
  createPullRequestToInferenceRecord
} from '../clickhouseClient.js'
import { renderComment } from '../generate-pr-patch/pullRequestCommentTemplate.js'

function maybeWriteDebugArtifact(
  outputDir: string | undefined,
  filename: string,
  content: string
): void {
  if (!outputDir) {
    return
  }
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  fs.writeFileSync(path.join(outputDir, filename), content, {
    encoding: 'utf-8'
  })
  console.log(
    `[Debug] ${filename} written to ${path.join(outputDir, filename)}`
  )
}

async function fetchDiffSummaryAndFullDiff(
  octokit: OctokitInstance,
  pr: PullRequestInfo,
  token: string
): Promise<{ diffSummary: string; fullDiff: string }> {
  console.log('[Agent Runner] Fetching PR diff via git...')
  const prResponse = await octokit.rest.pulls.get({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number
  })

  const diffResult = await getPullRequestDiff(
    token,
    pr.owner,
    pr.repo,
    prResponse.data
  )

  return {
    diffSummary: diffResult.diffSummary,
    fullDiff: diffResult.fullDiff
  }
}

/**
 * Run the agent to fix CI failures or improve a PR
 */
export async function runAgent(
  input: AgentRunnerInput
): Promise<AgentRunnerResult> {
  const {
    octokit,
    token,
    pullRequest,
    ciFailure,
    mode,
    outputDir,
    clickhouse,
    agent
  } = input

  const isDryRun = mode === 'dry-run'

  console.log('[Agent Runner] Starting agent execution...')
  console.log(`[Agent Runner] Mode: ${mode}`)
  console.log(
    `[Agent Runner] PR: ${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}`
  )

  // Prepare artifact directory
  const artifactDir = outputDir ? path.resolve(outputDir) : undefined
  if (artifactDir) {
    console.log(`[Agent Runner] Output artifact directory: ${artifactDir}`)
  }

  try {
    // Load diff summary and full diff
    const { diffSummary, fullDiff } = await fetchDiffSummaryAndFullDiff(
      octokit,
      pullRequest,
      token
    )
    maybeWriteDebugArtifact(
      artifactDir,
      'fetched-diff-summary.txt',
      diffSummary
    )
    maybeWriteDebugArtifact(artifactDir, 'fetched-full-diff.txt', fullDiff)

    // Clone the PR repository
    console.log('[Agent Runner] Cloning pull request repository...')
    const { repoDir, cleanup, git } = await clonePullRequestRepository(
      token,
      pullRequest.owner,
      pullRequest.repo,
      {
        number: pullRequest.number,
        head: { ref: pullRequest.headRef, sha: pullRequest.headSha },
        base: { ref: pullRequest.baseRef },
        html_url: pullRequest.htmlUrl
      } as any
    )

    try {
      // Write CI failure context file
      const ciContext: CIFailureContext = {
        repoFullName: `${pullRequest.owner}/${pullRequest.repo}`,
        branch: pullRequest.headRef,
        prNumber: pullRequest.number,
        workflowRunId: ciFailure?.workflowRunId,
        workflowRunUrl: ciFailure?.workflowRunUrl,
        prUrl: pullRequest.htmlUrl,
        prDescription: pullRequest.description ?? undefined,
        failedJobs: ciFailure?.failedJobs ?? [],
        diffSummary,
        fullDiff,
        failureLogs: ciFailure?.failureLogs ?? ''
      }

      const contextFilePath = writeCIFailureContextFile(repoDir, ciContext)
      console.log(
        `[Agent Runner] CI failure context written to: ${contextFilePath}`
      )

      // Prepare TensorZero config path
      const tensorZeroConfigPath = path.resolve(
        process.cwd(),
        'tensorzero',
        'swe_agent_config',
        'tensorzero.toml'
      )

      // Determine task based on whether we have CI failure info
      const task = ciFailure
        ? 'Fix the CI failures as described in ci_failure_context.md'
        : 'Review and improve the changes in this PR as described in ci_failure_context.md'

      // Run mini-swe-agent
      console.log('[Agent Runner] Running mini-swe-agent...')
      const agentResult = await runMiniSweAgent({
        task,
        cwd: repoDir,
        tensorZeroConfigPath,
        trajectoryOutputPath: artifactDir
          ? path.join(artifactDir, 'agent_trajectory.json')
          : path.join(repoDir, 'agent_trajectory.json'),
        costLimit: 3,
        timeout: agent.timeout * 60 * 1000, // Convert minutes to milliseconds
        prNumber: pullRequest.number
      })

      console.log(
        `[Agent Runner] Agent completed with decision: ${agentResult.completion.decision}`
      )
      console.log(
        `[Agent Runner] Agent reasoning: ${agentResult.completion.reasoning}`
      )

      // Save agent trajectory as debug artifact
      if (artifactDir) {
        maybeWriteDebugArtifact(
          artifactDir,
          'agent_trajectory.json',
          JSON.stringify(agentResult.trajectory, null, 2)
        )
      }

      // Get the git diff
      const diffOutput = await git.diff()
      const trimmedDiff = diffOutput.trim()

      if (!trimmedDiff) {
        console.log('[Agent Runner] No changes detected by agent.')
        return {
          success: true,
          decision: agentResult.completion.decision,
          reasoning: agentResult.completion.reasoning
        }
      }

      // Handle the agent's decision
      if (agentResult.completion.decision === 'INLINE_SUGGESTIONS') {
        console.log('[Agent Runner] Agent chose to provide inline suggestions')

        if (isDryRun) {
          console.log(
            '\n[DRY RUN] Would create inline suggestions with the following changes:'
          )
          console.log(trimmedDiff)
          return {
            success: true,
            diff: trimmedDiff,
            decision: 'INLINE_SUGGESTIONS',
            reasoning: agentResult.completion.reasoning
          }
        }

        // Parse the git diff to extract changes
        const fileChanges = await parseGitDiff(repoDir)

        if (fileChanges.length === 0) {
          console.log(
            '[Agent Runner] No file changes detected; skipping review comments.'
          )
          return {
            success: true,
            diff: trimmedDiff,
            decision: 'INLINE_SUGGESTIONS',
            reasoning: agentResult.completion.reasoning
          }
        }

        // Create review comments
        const reviewComments = createReviewComments(
          fileChanges,
          agentResult.completion.reasoning
        )

        // Post review comments to GitHub
        await postReviewComments(
          octokit,
          pullRequest.owner,
          pullRequest.repo,
          pullRequest.number,
          reviewComments,
          pullRequest.headSha
        )

        console.log(
          `[Agent Runner] Posted ${reviewComments.length} inline suggestion(s) to PR #${pullRequest.number}`
        )

        return {
          success: true,
          diff: trimmedDiff,
          decision: 'INLINE_SUGGESTIONS',
          reasoning: agentResult.completion.reasoning
        }
      } else {
        // PULL_REQUEST decision
        console.log('[Agent Runner] Agent chose to create a follow-up PR')

        if (isDryRun) {
          console.log(
            '\n[DRY RUN] Would create a follow-up PR with the following patch:'
          )
          console.log(trimmedDiff)
          return {
            success: true,
            diff: trimmedDiff,
            decision: 'PULL_REQUEST',
            reasoning: agentResult.completion.reasoning
          }
        }

        // Create follow-up PR
        let followupPr: FollowupPrResult | undefined
        let followupPrCreationError: string | undefined

        try {
          followupPr = await createFollowupPr(
            {
              octokit,
              token,
              owner: pullRequest.owner,
              repo: pullRequest.repo,
              pullRequest: {
                number: pullRequest.number,
                head: { ref: pullRequest.headRef, sha: pullRequest.headSha },
                base: { ref: pullRequest.baseRef },
                html_url: pullRequest.htmlUrl
              } as any,
              diff: trimmedDiff
            },
            artifactDir
          )

          if (followupPr) {
            console.log(
              `[Agent Runner] Created follow-up PR #${followupPr.number}`
            )

            // Record inference in ClickHouse if configured
            if (clickhouse) {
              const inferenceId = `agent-${pullRequest.number}-${Date.now()}`

              const request: CreatePullRequestToInferenceRequest = {
                inferenceId,
                pullRequestId: followupPr.id,
                originalPullRequestUrl: pullRequest.htmlUrl
              }

              try {
                await createPullRequestToInferenceRecord(request, clickhouse)
                console.log(
                  `[Agent Runner] Recorded inference ${inferenceId} for follow-up PR #${followupPr.number} in ClickHouse.`
                )
              } catch (error) {
                const errorMessage =
                  error instanceof Error ? error.message : `${error}`
                console.warn(
                  `[Agent Runner] Failed to record inference in ClickHouse: ${errorMessage}`
                )
              }
            }
          }
        } catch (error) {
          followupPrCreationError =
            error instanceof Error ? error.message : `${error}`
          console.error(
            `[Agent Runner] Failed to create follow-up PR: ${followupPrCreationError}`
          )
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
              owner: pullRequest.owner,
              repo: pullRequest.repo,
              issue_number: pullRequest.number,
              body: comment
            })
            console.log(
              `[Agent Runner] Posted comment on PR #${pullRequest.number}`
            )
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : `${error}`
            console.warn(
              `[Agent Runner] Failed to create comment on pull request: ${errorMessage}`
            )
          }
        }

        return {
          success: true,
          diff: trimmedDiff,
          decision: 'PULL_REQUEST',
          reasoning: agentResult.completion.reasoning,
          followupPrNumber: followupPr?.number,
          error: followupPrCreationError
        }
      }
    } finally {
      // Clean up cloned repository
      await cleanup()
      console.log('[Agent Runner] Cleaned up temporary repository')
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : `${error}`
    console.error(`[Agent Runner] Failed to run agent: ${errorMessage}`)

    if (error instanceof Error && error.stack) {
      console.error(error.stack)
    }

    return {
      success: false,
      error: errorMessage
    }
  }
}
