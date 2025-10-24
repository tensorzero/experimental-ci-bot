import * as core from '@actions/core'
import { createAgentInputFromGitHubActions } from '../adapters/github-actions.js'
import { runAgent } from '../core/agent-runner.js'

/**
 * Collects artifacts, runs mini-swe-agent to fix CI failures, then posts
 * inline suggestions or creates a follow-up PR based on the agent's decision.
 *
 * @returns Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    // Create agent input from GitHub Actions context
    const agentInput = await createAgentInputFromGitHubActions()

    if (!agentInput) {
      core.warning('Unable to create agent input; skipping action.')
      return
    }

    // Run the agent
    core.info('Starting agent execution...')
    const result = await runAgent(agentInput)

    // Check result
    if (result.success) {
      core.info('Agent execution completed successfully')
      if (result.followupPrNumber) {
        core.info(`Created follow-up PR #${result.followupPrNumber}`)
      }
    } else {
      core.setFailed(
        `Agent execution failed: ${result.error ?? 'Unknown error'}`
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
  const episodeId = response.episode_id

  if (followupPr) {
    // This version currently only contains one inference per episode; soon with miniswe-agent, we will have many inferences per episode.
    // When that launches, we will switch to only create PR-episode associations.
    const request: CreatePullRequestToInferenceRequest = {
      inferenceId,
      episodeId,
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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : `${error}`
    core.setFailed(`Action failed: ${errorMessage}`)
  }
}
