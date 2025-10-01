import { createClient } from '@clickhouse/client'

export type ClickHouseClientLike = Pick<
  ReturnType<typeof createClient>,
  'insert' | 'query' | 'close'
>

export interface ClickHouseDependencies {
  client?: ClickHouseClientLike
}

export interface ClickHouseConfig {
  url: string
  table: string
}

export interface CreatePullRequestToInferenceRequest {
  inferenceId: string
  pullRequestId: number
  originalPullRequestUrl: string
}

export interface PullRequestToInferenceRecord {
  inference_id: string
  pull_request_id: number
  created_at: string
  original_pull_request_url: string
}

const CLICKHOUSE_TABLE_NAME_REGEX = /^[a-zA-Z0-9_.]+$/

function assertValidTableName(table: string): void {
  if (!CLICKHOUSE_TABLE_NAME_REGEX.test(table)) {
    throw new Error(
      'ClickHouse table name must contain only alphanumeric characters, underscores, or dots.'
    )
  }
}

function normalizeAndValidateClickHouseConfig(
  config: ClickHouseConfig
): Required<ClickHouseConfig> {
  const url = config.url?.trim()
  const table = config.table?.trim()

  if (!url) {
    throw new Error(
      'ClickHouse URL is required when configuring ClickHouse logging; provide one via the `clickhouse-url` input.'
    )
  }

  if (!table) {
    throw new Error(
      'ClickHouse table name is required when configuring ClickHouse logging; provide one via the `clickhouse-table` input.'
    )
  }

  assertValidTableName(table)

  return { url, table }
}

function createTensorZeroClickHouseClient(
  config: ClickHouseConfig,
  dependencies?: ClickHouseDependencies
): {
  client: ClickHouseClientLike
  table: string
  shouldClose: boolean
} {
  const normalizedConfig = normalizeAndValidateClickHouseConfig(config)
  if (dependencies?.client) {
    return {
      client: dependencies.client,
      table: normalizedConfig.table,
      shouldClose: false
    }
  }

  return {
    client: createClient({
      url: normalizedConfig.url,
      application: 'tensorzero-github-action'
    }),
    table: normalizedConfig.table,
    shouldClose: true
  }
}

export async function createPullRequestToInferenceRecord(
  request: CreatePullRequestToInferenceRequest,
  config: ClickHouseConfig,
  dependencies?: ClickHouseDependencies
): Promise<void> {
  const { client, table, shouldClose } = createTensorZeroClickHouseClient(
    config,
    dependencies
  )
  try {
    await client.insert({
      table,
      values: [
        {
          pull_request_id: request.pullRequestId,
          inference_id: request.inferenceId,
          original_pull_request_url: request.originalPullRequestUrl
        }
      ],
      format: 'JSONEachRow'
    })
  } finally {
    if (shouldClose) {
      await client.close()
    }
  }
}

// Returns all inference records for a given pull request. There should only be one since so far for simplicity, the table should be created with a ReplacingMergeTree, but we may want to support multiple inferences for interactive PR updates.
export async function getPullRequestToInferenceRecords(
  pullRequestId: number,
  config: ClickHouseConfig,
  dependencies?: ClickHouseDependencies
): Promise<PullRequestToInferenceRecord[]> {
  const { client, table, shouldClose } = createTensorZeroClickHouseClient(
    config,
    dependencies
  )
  let records: PullRequestToInferenceRecord[] = []
  try {
    const response = await client.query({
      query: `SELECT inference_id, pull_request_id, created_at, original_pull_request_url FROM ${table} WHERE pull_request_id = {pullRequestId:UInt64}`,
      query_params: { pullRequestId },
      format: 'JSONEachRow'
    })
    records = await response.json()
  } finally {
    if (shouldClose) {
      await client.close()
    }
  }
  return records
}
