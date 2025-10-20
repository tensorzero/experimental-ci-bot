#!/usr/bin/env node
/**
 * CLI entry point for running the mini-swe-agent locally
 */
import { parseArgs } from './args.js'
import { createAgentInputFromCli } from '../adapters/cli.js'
import { runAgent } from '../core/agent-runner.js'

async function main(): Promise<void> {
  console.log('=== Mini SWE Agent CLI ===\n')

  // Parse command-line arguments
  const options = parseArgs(process.argv.slice(2))

  console.log(`Repository: ${options.repository}`)
  console.log(`Pull Request: #${options.pr}`)
  console.log(`Mode: ${options.dryRun ? 'DRY RUN (local only)' : 'LIVE (will create PRs/comments)'}`)
  console.log(`Cost Limit: $${options.costLimit}`)
  console.log(`Timeout: ${options.timeout} minutes`)
  if (options.workflowRunId) {
    console.log(`Workflow Run ID: ${options.workflowRunId}`)
  }
  if (options.outputDir) {
    console.log(`Output Directory: ${options.outputDir}`)
  }
  console.log()

  // Validate required environment variables
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    console.error(
      'Error: Neither ANTHROPIC_API_KEY nor OPENAI_API_KEY is set. At least one is required for mini-swe-agent.'
    )
    process.exit(1)
  }

  try {
    // Create agent input from CLI options
    console.log('[CLI] Preparing agent input...')
    const agentInput = await createAgentInputFromCli(options)

    // Run the agent
    console.log('[CLI] Starting agent...\n')
    const result = await runAgent(agentInput)

    // Display results
    console.log('\n=== Agent Execution Complete ===\n')

    if (result.success) {
      console.log('✓ Status: SUCCESS')
      if (result.decision) {
        console.log(`Decision: ${result.decision}`)
      }
      if (result.reasoning) {
        console.log(`\nReasoning:\n${result.reasoning}`)
      }

      if (result.diff) {
        console.log(`\n--- Generated Changes ---`)
        console.log(result.diff)
        console.log(`--- End of Changes ---\n`)
      }

      if (result.followupPrNumber) {
        console.log(`\n✓ Created follow-up PR #${result.followupPrNumber}`)
      }

      if (options.dryRun && result.diff) {
        console.log('\n[DRY RUN] No changes were made to GitHub.')
        console.log('To apply these changes, run again without --dry-run flag.')
      }

      process.exit(0)
    } else {
      console.error('✗ Status: FAILED')
      if (result.error) {
        console.error(`Error: ${result.error}`)
      }
      process.exit(1)
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : `${error}`
    console.error(`\n✗ Fatal Error: ${errorMessage}`)

    if (error instanceof Error && error.stack) {
      console.error('\nStack trace:')
      console.error(error.stack)
    }

    process.exit(1)
  }
}

// Run the CLI
main().catch((error) => {
  console.error('Unhandled error:', error)
  process.exit(1)
})
