import type { ClickHouseConfig } from '../clickhouseClient.js'
import type {
  OctokitInstance,
  PullRequestData,
  FollowupPrResult,
  CreateFollowupPrOptions
} from '../pullRequests.js'

export type {
  OctokitInstance,
  PullRequestData,
  FollowupPrResult,
  CreateFollowupPrOptions
}

export interface GeneratePrPatchActionInput {
  token: string
  tensorZeroBaseUrl: string
  tensorZeroDiffPatchedSuccessfullyMetricName: string
  outputArtifactsDir: string | undefined
  clickhouse: ClickHouseConfig
}

export interface WorkflowJobStep {
  name: string
  status: string
  conclusion: string | undefined
}

export interface WorkflowJob {
  id: number
  name: string
  conclusion: string | undefined
  status: string
  html_url?: string
  steps?: WorkflowJobStep[]
}

export interface WorkflowJobsResponse {
  total_count: number
  jobs: WorkflowJob[]
}
