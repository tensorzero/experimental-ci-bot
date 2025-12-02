import * as core from '@actions/core'
import {
  createAgentInputFromGitHubActions,
  setActionOutputs
} from '../adapters/github-actions.js'
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
      // Set has-changes to false so downstream jobs know there's nothing to do
      setActionOutputs({ hasChanges: false })
      return
    }

    // Run the agent
    core.info('Starting agent execution...')
    const result = await runAgent(agentInput)

    // Set action outputs
    const hasChanges = result.success && !!result.diff
    setActionOutputs({
      hasChanges,
      patchFile: result.patchFile,
      metadataFile: result.metadataFile
    })

    // Check result
    if (result.success) {
      core.info('Agent execution completed successfully')
      if (result.followupPrNumber) {
        core.info(`Created follow-up PR #${result.followupPrNumber}`)
      }
      if (result.patchFile) {
        core.info(`Patch file written to: ${result.patchFile}`)
      }
    } else {
      core.setFailed(
        `Agent execution failed: ${result.error ?? 'Unknown error'}`
      )
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : `${error}`
    core.setFailed(`Action failed: ${errorMessage}`)
  }
}
