import { beforeEach, describe, expect, it, jest } from '@jest/globals'

import {
  type ClickHouseClientLike,
  type ClickHouseConfig,
  createPullRequestToInferenceRecord,
  getPullRequestToInferenceRecords
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
        pullRequestId: 42,
        originalPullRequestUrl: 'https://github.com/org/repo/pull/42'
      },
      defaultConfig,
      { client }
    )

    expect(client.insert).toHaveBeenCalledWith({
      table: 'tensorzero.inference_records',
      values: [
        {
          pull_request_id: 42,
          inference_id: 'abc-123',
          original_pull_request_url: 'https://github.com/org/repo/pull/42'
        }
      ],
      format: 'JSONEachRow'
    })
    expect(client.close).not.toHaveBeenCalled()
  })

  it('queries inference records with parameter binding', async () => {
    const expectedRecords = [
      {
        inference_id: 'xyz',
        pull_request_id: 77,
        created_at: '2024-01-01T00:00:00Z',
        original_pull_request_url: 'https://github.com/org/repo/pull/77'
      }
    ]
    const jsonMock = jest
      .fn<() => Promise<unknown>>()
      .mockResolvedValue(expectedRecords)
    // @ts-expect-error(Mock type is inaccurate)
    client.query.mockResolvedValueOnce({ json: jsonMock })

    const records = await getPullRequestToInferenceRecords(77, defaultConfig, {
      client
    })

    expect(client.query).toHaveBeenCalledWith({
      query:
        'SELECT inference_id, pull_request_id, created_at, original_pull_request_url FROM tensorzero.inference_records WHERE pull_request_id = {pullRequestId:UInt64}',
      query_params: { pullRequestId: 77 },
      format: 'JSONEachRow'
    })
    expect(jsonMock).toHaveBeenCalledTimes(1)
    expect(records).toEqual(expectedRecords)
  })

  it('throws when the table name fails validation', async () => {
    await expect(
      createPullRequestToInferenceRecord(
        {
          inferenceId: 'abc',
          pullRequestId: 1,
          originalPullRequestUrl: 'https://example.com/pr/1'
        },
        { ...defaultConfig, table: 'invalid-table!' }
      )
    ).rejects.toThrow('ClickHouse table name must contain only')
  })

  it('validates missing URL', async () => {
    await expect(
      createPullRequestToInferenceRecord(
        {
          inferenceId: 'abc',
          pullRequestId: 1,
          originalPullRequestUrl: 'https://example.com/pr/1'
        },
        { ...defaultConfig, url: ' ' }
      )
    ).rejects.toThrow('ClickHouse URL is required')
  })

  it('propagates insert failures from the injected client without closing it', async () => {
    client.insert.mockRejectedValueOnce(new Error('insert failed'))

    await expect(
      createPullRequestToInferenceRecord(
        {
          inferenceId: 'abc',
          pullRequestId: 1,
          originalPullRequestUrl: 'https://example.com/pr/1'
        },
        defaultConfig,
        { client }
      )
    ).rejects.toThrow('insert failed')

    expect(client.close).not.toHaveBeenCalled()
  })
})
