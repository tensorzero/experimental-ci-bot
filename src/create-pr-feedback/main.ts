import * as core from '@actions/core'
import * as github from '@actions/github'
import { CreatePrFeedbackActionInput } from './types.js'
import {
  type PullRequestToInferenceRecord,
  getPullRequestToInferenceRecords
} from '../clickhouseClient.js'
import { provideInferenceFeedback } from '../tensorZeroClient.js'

function parseAndValidateActionInputs(): CreatePrFeedbackActionInput {
  const tensorZeroBaseUrl = core.getInput('tensorzero-base-url')?.trim()
  if (!tensorZeroBaseUrl) {
    throw new Error(
      'TensorZero base url is required; provide one via the `tensorzero-base-url` input.'
    )
  }
  const tensorZeroPrMergedMetricName = core
    .getInput('tensorzero-pr-merged-metric-name')
    ?.trim()
  if (!tensorZeroPrMergedMetricName) {
    throw new Error(
      'TensorZero PR merged metric name is required; provide one via the `tensorzero-pr-merged-metric-name` input.'
    )
  }
  const clickhouseUrl = core.getInput('clickhouse-url')?.trim()
  if (!clickhouseUrl) {
    throw new Error(
      'ClickHouse URL is required; provide one via the `clickhouse-url` input.'
    )
  }
  const clickhouseTable = core.getInput('clickhouse-table')?.trim()
  if (!clickhouseTable) {
    throw new Error(
      'ClickHouse Table is required; provide one via the `clickhouse-table` input.'
    )
  }
  return {
    tensorZeroBaseUrl,
    tensorZeroPrMergedMetricName,
    clickhouse: {
      url: clickhouseUrl,
      table: clickhouseTable
    }
  }
}

function isPullRequestEligibleForFeedback(
  inferenceRecords: PullRequestToInferenceRecord[]
): boolean {
  const pullRequestState = github.context.payload.pull_request?.state
  if (!pullRequestState) {
    core.warning(`Pull Request State is not set. Skipping action.`)
    return false
  } else if (pullRequestState !== 'closed') {
    core.warning(`Pull Request is not closed. Skipping action.`)
    return false
  }
  if (github.context.payload.pull_request?.number === undefined) {
    core.warning(`Pull Request Number is not set. Skipping action.`)
    return false
  }
  if (inferenceRecords.length === 0) {
    core.warning(
      `Pull request doesn't have any inference records. Skipping action.`
    )
    return false
  }
  if (inferenceRecords.length > 1) {
    core.warning(
      `Pull request has multiple inference records. This might indicate an issue but we will proceed and provide feedback on all of them.`
    )
  }
  core.info(`Pull Request State: ${pullRequestState}`)
  return true
}

export async function run(): Promise<void> {
  const inputs = parseAndValidateActionInputs()
  const { tensorZeroBaseUrl, tensorZeroPrMergedMetricName, clickhouse } = inputs

  const pullRequestId = github.context.payload.pull_request?.id
  if (!pullRequestId) {
    throw new Error('Did not receive a pull request ID from the context.')
  }
  core.info(
    `Handling Pull Request ID ${pullRequestId} (#${github.context.payload.pull_request?.number}); merged: ${github.context.payload.pull_request?.merged}.`
  )

  const isPullRequestMerged =
    (github.context.payload.pull_request?.merged as boolean) ?? false

  const inferenceRecords = await getPullRequestToInferenceRecords(
    pullRequestId,
    clickhouse
  )
  if (!isPullRequestEligibleForFeedback(inferenceRecords)) {
    return
  }

  // Provide feedback for follow-up PRs
  const feedbackReason: string = isPullRequestMerged
    ? 'Pull Request Merged'
    : 'Pull Request Rejected'
  await Promise.all(
    inferenceRecords.map(async (record) => {
      await provideInferenceFeedback(
        tensorZeroBaseUrl,
        tensorZeroPrMergedMetricName,
        record.inference_id,
        isPullRequestMerged,
        { reason: feedbackReason }
      )
      core.info(
        `Feedback (${isPullRequestMerged}) provided for inference ${record.inference_id}`
      )
    })
  )

  // TODO: Add feedback collection for inline suggestions
  // This requires:
  // 1. Tracking which review comments were posted by the bot
  // 2. Checking if those suggestions were accepted (commits were made with the suggested changes)
  // 3. Calculating acceptance rate
  // 4. Sending feedback to TensorZero with ci_fix_suggestions_accepted_rate metric
  core.info('Inline suggestion feedback collection not yet implemented')
}
