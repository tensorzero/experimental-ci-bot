/**
 * Shared types for core agent runner logic
 */
import type { OctokitInstance } from '../pullRequests.js'
import type { FailedJobSummary } from '../tensorZeroClient.js'

/**
 * Information about a pull request
 */
export interface PullRequestInfo {
  owner: string
  repo: string
  number: number
  headSha: string
  headRef: string
  baseRef: string
  htmlUrl: string
  description: string | null
}

/**
 * CI failure context (optional - may not be available for local runs)
 */
export interface CIFailureInfo {
  workflowRunId: number
  workflowRunUrl: string
  failedJobs: FailedJobSummary[]
  failureLogs: string
}

/**
 * Core input for the agent runner
 */
export interface AgentRunnerInput {
  /**
   * Octokit instance for GitHub API calls
   */
  octokit: OctokitInstance

  /**
   * GitHub token
   */
  token: string

  /**
   * Pull request information
   */
  pullRequest: PullRequestInfo

  /**
   * Optional CI failure information
   */
  ciFailure?: CIFailureInfo

  /**
   * Execution mode
   */
  mode: 'dry-run' | 'live'

  /**
   * Output directory for debug artifacts
   */
  outputDir?: string

  /**
   * Optional ClickHouse configuration for tracking
   */
  clickhouse?: {
    url: string
    table: string
  }

  /**
   * TensorZero configuration
   */
  tensorZero?: {
    baseUrl?: string
    diffPatchedSuccessfullyMetricName?: string
  }

  /**
   * Mini-swe-agent configuration
   */
  agent: {
    costLimit: number
    timeout: number
  }

  /**
   * Test mode - add comments to files without running agent (for integration testing)
   */
  testMode?: boolean
}

/**
 * Result from the agent runner
 */
export interface AgentRunnerResult {
  /**
   * Whether the agent completed successfully
   */
  success: boolean

  /**
   * The generated diff/patch
   */
  diff?: string

  /**
   * Decision made by the agent
   */
  decision?: 'INLINE_SUGGESTIONS' | 'PULL_REQUEST'

  /**
   * Reasoning from the agent
   */
  reasoning?: string

  /**
   * Follow-up PR number if created
   */
  followupPrNumber?: number

  /**
   * Error message if failed
   */
  error?: string
}
