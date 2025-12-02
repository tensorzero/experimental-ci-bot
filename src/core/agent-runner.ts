/**
 * Core agent runner logic shared between GitHub Actions and CLI
 */
import * as fs from 'fs'
import * as path from 'path'
import type { AgentRunnerInput, AgentRunnerResult } from './types.js'

import {
  createFollowupPrFromWorkingDir,
  type FollowupPrResult
} from '../pullRequests.js'
import { runMiniSweAgent } from '../miniSweAgentClient.js'
import {
  writeCIFailureContextFile,
  type CIFailureContext
} from '../generate-pr-patch/ciFailureContext.js'
import { clonePullRequestRepository } from '../git.js'
import {
  type CreatePullRequestToInferenceRequest,
  createPullRequestToInferenceRecord
} from '../clickhouseClient.js'
import { renderComment } from '../generate-pr-patch/pullRequestCommentTemplate.js'
import { provideEpisodeFeedback } from '../tensorZeroClient.js'
import {
  fetchDiffSummaryAndFullDiff,
  maybeWriteDebugArtifact
} from './utils.js'

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

  // Declare these at function scope so they're accessible in catch blocks
  let repoDir: string | undefined
  let episodeId: string | undefined

  try {
    // Load diff summary and full diff
    const { diffSummary, fullDiff, prData } = await fetchDiffSummaryAndFullDiff(
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
    const cloneResult = await clonePullRequestRepository(
      token,
      pullRequest.owner,
      pullRequest.repo,
      {
        head: { ref: pullRequest.headRef, sha: pullRequest.headSha },
        base: { ref: pullRequest.baseRef }
      }
    )
    repoDir = cloneResult.repoDir
    const cleanup = cloneResult.cleanup
    const git = cloneResult.git

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

      // Determine task based on whether we have CI failure info
      const task = ciFailure
        ? 'Fix the CI failures as described in ci_failure_context.md'
        : 'Review and improve the changes in this PR as described in ci_failure_context.md'

      // Hardcoded TensorZero gateway URL
      const tensorZeroGatewayUrl = 'http://ci-bot-gateway:3000'

      console.log('[Agent Runner] Running mini-swe-agent...')
      const agentResult = await runMiniSweAgent({
        task,
        cwd: repoDir,
        tensorZeroGatewayUrl,
        costLimit: 3,
        timeout: agent.timeout * 60 * 1000, // Convert minutes to milliseconds
        prNumber: pullRequest.number
      })

      const agentCompletion = agentResult.completion
      episodeId = agentResult.episodeId

      console.log(
        `[Agent Runner] Agent reasoning: ${agentResult.completion.reasoning}`
      )

      console.log(
        `[Agent Runner] Completion reasoning: ${agentCompletion.reasoning}`
      )

      // Clean up the CI failure context file before git operations
      // This prevents it from being committed in the follow-up PR
      try {
        fs.rmSync(contextFilePath, { force: true })
        console.log(
          `[Agent Runner] Cleaned up CI failure context file: ${contextFilePath}`
        )
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : `${error}`
        console.warn(
          `[Agent Runner] Failed to clean up CI failure context file: ${errorMessage}`
        )
      }

      // Get the git diff
      const diffOutput = await git.diff()
      const trimmedDiff = diffOutput.trim()

      if (!trimmedDiff) {
        console.log('[Agent Runner] No changes detected by agent.')
        return {
          success: true,
          episodeId,
          reasoning: agentCompletion.reasoning
        }
      }

      // Debug logging: show diff statistics
      const diffLines = trimmedDiff.split('\n')
      const filesChanged = diffLines.filter((line) =>
        line.startsWith('diff --git')
      ).length
      const additions = diffLines.filter((line) => line.startsWith('+')).length
      const deletions = diffLines.filter((line) => line.startsWith('-')).length
      console.log(
        `[Agent Runner] Diff statistics: ${filesChanged} files, +${additions} -${deletions} lines`
      )

      // Save diff as debug artifact
      maybeWriteDebugArtifact(artifactDir, 'agent-changes.diff', trimmedDiff)

      // Create a follow-up PR with the changes
      console.log('[Agent Runner] Creating a follow-up PR with the changes')

      if (isDryRun) {
        console.log(
          '\n[DRY RUN] Would create a follow-up PR with the following patch:'
        )
        console.log(trimmedDiff)
        return {
          success: true,
          episodeId,
          diff: trimmedDiff,
          reasoning: agentCompletion.reasoning
        }
      }

      // Create follow-up PR directly from the working directory
      let followupPr: FollowupPrResult | undefined
      let followupPrCreationError: string | undefined

      try {
        followupPr = await createFollowupPrFromWorkingDir(
          {
            octokit,
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            pullRequest: prData,
            git,
            reasoning: agentCompletion.reasoning
          },
          artifactDir
        )

        if (followupPr && clickhouse) {
          console.log(
            `[Agent Runner] Created follow-up PR #${followupPr.number}`
          )

          const request: CreatePullRequestToInferenceRequest = {
            inferenceId: undefined,
            episodeId,
            pullRequestId: followupPr.id
          }
          try {
            await createPullRequestToInferenceRecord(request, clickhouse)
            console.info(
              `Recorded episode ${episodeId} for follow-up PR #${followupPr.number} (id ${followupPr.id}) in ClickHouse.`
            )
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : `${error}`
            console.warn(
              `Failed to record episode ${episodeId} for follow-up PR #${followupPr.number} (id ${followupPr.id}) in ClickHouse: ${errorMessage}`
            )
          }
        }

        // Provide feedback for PR creation success
        if (followupPr && episodeId && input.tensorZero?.baseUrl) {
          try {
            await provideEpisodeFeedback(
              input.tensorZero.baseUrl,
              'ci_fix_pr_created_agent',
              episodeId,
              true
            )
            console.info(
              `[Agent Runner] Provided feedback: ci_fix_pr_created_agent=true for episode ${episodeId}`
            )
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : `${error}`
            console.warn(
              `[Agent Runner] Failed to provide feedback for PR creation: ${errorMessage}`
            )
          }
        }
      } catch (error) {
        followupPrCreationError =
          error instanceof Error ? error.message : `${error}`
        console.error(
          `[Agent Runner] Failed to create follow-up PR: ${followupPrCreationError}`
        )

        // Provide feedback for PR creation failure
        if (episodeId && input.tensorZero?.baseUrl) {
          try {
            await provideEpisodeFeedback(
              input.tensorZero.baseUrl,
              'ci_fix_pr_created_agent',
              episodeId,
              false
            )
            console.info(
              `[Agent Runner] Provided feedback: ci_fix_pr_created_agent=false for episode ${episodeId}`
            )
            await provideEpisodeFeedback(
              input.tensorZero.baseUrl,
              'ci_fix_pr_merged_agent',
              episodeId,
              false
            )
            console.info(
              `[Agent Runner] Provided feedback: ci_fix_pr_merged_agent=false for episode ${episodeId}`
            )
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : `${error}`
            console.warn(
              `[Agent Runner] Failed to provide feedback for PR creation failure: ${errorMessage}`
            )
          }
        }
      }

      // Post a comment on the original PR
      const comment = renderComment({
        generatedCommentBody: agentCompletion.reasoning,
        generatedPatch: trimmedDiff,
        commands: [],
        followupPrNumber: followupPr?.number,
        followupPrUrl: followupPr?.htmlUrl,
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
        episodeId,
        diff: trimmedDiff,
        reasoning: agentCompletion.reasoning,
        followupPrNumber: followupPr?.number,
        error: followupPrCreationError
      }
    } catch (innerError) {
      // Try to read episode_id from .episode_id file before cleanup
      // This handles the case where mini-swe-agent wrote the episode_id but then crashed
      if (repoDir && !episodeId) {
        try {
          const episodeIdPath = path.join(repoDir, '.episode_id')
          if (fs.existsSync(episodeIdPath)) {
            episodeId = fs.readFileSync(episodeIdPath, 'utf-8').trim()
            console.log(
              `[Agent Runner] Recovered episode ID from .episode_id file: ${episodeId}`
            )
          }
        } catch (readError) {
          const readErrorMessage =
            readError instanceof Error ? readError.message : `${readError}`
          console.warn(
            `[Agent Runner] Failed to read .episode_id file: ${readErrorMessage}`
          )
        }
      }
      // Re-throw the error to be handled by outer catch block
      throw innerError
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

    // Provide feedback for agent failure
    // Note: episodeId may have been recovered from .episode_id file if the agent started but failed
    if (episodeId && input.tensorZero?.baseUrl) {
      try {
        await provideEpisodeFeedback(
          input.tensorZero.baseUrl,
          'ci_fix_pr_created_agent',
          episodeId,
          false
        )
        console.info(
          `[Agent Runner] Provided feedback: ci_fix_pr_created_agent=false for episode ${episodeId}`
        )
      } catch (feedbackError) {
        const feedbackErrorMessage =
          feedbackError instanceof Error
            ? feedbackError.message
            : `${feedbackError}`
        console.warn(
          `[Agent Runner] Failed to provide feedback for agent failure: ${feedbackErrorMessage}`
        )
      }
      try {
        await provideEpisodeFeedback(
          input.tensorZero.baseUrl,
          'ci_fix_pr_merged_agent',
          episodeId,
          false
        )
        console.info(
          `[Agent Runner] Provided feedback: ci_fix_pr_merged_agent=false for episode ${episodeId}`
        )
      } catch (feedbackError) {
        const feedbackErrorMessage =
          feedbackError instanceof Error
            ? feedbackError.message
            : `${feedbackError}`
        console.warn(
          `[Agent Runner] Failed to provide feedback for agent failure: ${feedbackErrorMessage}`
        )
      }
    }

    return {
      success: false,
      episodeId,
      error: errorMessage
    }
  }
}
