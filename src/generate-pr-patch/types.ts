import type { ClickHouseConfig } from '../clickhouseClient.js'

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

export type OctokitInstance = ReturnType<
  typeof import('@actions/github').getOctokit
>

export type PullRequestData = Awaited<
  ReturnType<OctokitInstance['rest']['pulls']['get']>
>['data']

export interface FollowupPrResult {
  number: number
  id: number
  htmlUrl: string
}

export interface CreateFollowupPrOptions {
  octokit: OctokitInstance
  token: string
  owner: string
  repo: string
  pullRequest: PullRequestData
  diff: string
}
