import { beforeEach, describe, expect, it, jest } from '@jest/globals'

import {
  type ClickHouseClientLike,
  type ClickHouseConfig,
  createPullRequestToInferenceRecord,
  getPullRequestToEpisodeRecords
} from './clickhouseClient.js'

const defaultConfig: ClickHouseConfig = {
  url: 'https://clickhouse.example.com',
  table: 'tensorzero.inference_records'
}

function createMockClient(): jest.Mocked<ClickHouseClientLike> {
  return {
    insert: jest.fn(),
    query: jest.fn(),
    close: jest.fn()
  }
}

describe('clickhouseClient', () => {
  let client: jest.Mocked<ClickHouseClientLike>

  beforeEach(() => {
    client = createMockClient()
  })

  it('writes inference records using structured inserts', async () => {
    await createPullRequestToInferenceRecord(
      {
        inferenceId: 'abc-123',
        episodeId: 'episode-123',
        pullRequestId: 42
      },
      defaultConfig,
      { client }
    )

    expect(client.insert).toHaveBeenCalledWith({
      table: 'tensorzero.inference_records',
      values: [
        {
          inference_id: 'abc-123',
          episode_id: 'episode-123',
          pull_request_id: 42
        }
      ],
      format: 'JSONEachRow'
    })
  })

  it('queries episode records for a pull request', async () => {
    const mockRows = [
      { episode_id: 'ep1', pull_request_id: 123 },
      { episode_id: 'ep2', pull_request_id: 123 }
    ]

    client.query.mockResolvedValue({
      json: jest.fn().mockResolvedValue(mockRows)
    } as never)

    const result = await getPullRequestToEpisodeRecords(123, defaultConfig, {
      client
    })

    expect(result).toEqual(mockRows)
    expect(client.query).toHaveBeenCalledWith({
      query: expect.stringContaining('SELECT episode_id, pull_request_id'),
      query_params: { pullRequestId: 123 },
      format: 'JSONEachRow'
    })
  })
})
