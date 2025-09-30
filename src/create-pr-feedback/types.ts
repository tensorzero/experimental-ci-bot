import type { ClickHouseConfig } from '../clickhouseClient.js'

export interface CreatePrFeedbackActionInput {
  tensorZeroBaseUrl: string
  tensorZeroPrMergedMetricName: string
  clickhouse: ClickHouseConfig
}
