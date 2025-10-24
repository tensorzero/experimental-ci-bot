import { OpenAI } from 'openai'
import * as core from '@actions/core'

export type TensorZeroOpenAiInferenceResponse =
  OpenAI.Chat.Completions.ChatCompletion & TensorZeroInferenceResponse
export interface FailedStepSummary {
  name: string
  status: string
  conclusion: string | undefined
}

export interface FailedJobSummary {
  name: string
  conclusion: string | undefined
  failed_steps: FailedStepSummary[]
  html_url?: string
}

export type TensorZeroGenerationArguments = {
  repo_full_name: string
  branch: string
  pr_number: number
  failed_jobs: FailedJobSummary[]
  diff_summary: string
  full_diff: string
  failure_logs: string
}

interface TensorZeroInferenceResponse {
  // Inference ID
  id: string
  episode_id: string
  variant_name: string
}

export interface TensorZeroFeedbackRequest<T> {
  metric_name: string
  inference_id: string
  value: T
  tags?: TensorZeroGithubCiBotFeedbackTags
}

export interface TensorZeroEpisodeFeedbackRequest<T> {
  metric_name: string
  episode_id: string
  value: T
  tags?: TensorZeroGithubCiBotFeedbackTags
}

export interface TensorZeroGithubCiBotFeedbackTags {
  reason: string
}

function getOpenAiCompatibleUrl(baseUrl: string): string {
  if (baseUrl[baseUrl.length - 1] === '/') {
    baseUrl = baseUrl.slice(0, -1)
  }
  return `${baseUrl}/openai/v1`
}

export async function callTensorZeroOpenAi(
  tensorZeroBaseUrl: string,
  generationArguments: TensorZeroGenerationArguments
): Promise<TensorZeroOpenAiInferenceResponse> {
  const tensorZeroOpenAiEndpointUrl = getOpenAiCompatibleUrl(tensorZeroBaseUrl)
  const client = new OpenAI({
    baseURL: tensorZeroOpenAiEndpointUrl,
    // API key is supplied from the Gateway; we just need an API key for OpenAI client to be happy.
    apiKey: 'dummy'
  })
  // @ts-expect-error(TensorZero-patched interface doesn't agree with OpenAI)
  return await client.chat.completions.create({
    model: 'tensorzero::function_name::tensorzero_github_ci_bot',
    messages: [
      {
        content: [
          {
            // @ts-expect-error(TensorZero-patched interface adds a function type)
            type: 'tensorzero::template',
            name: 'generate_pr_and_comment',
            arguments: generationArguments
          }
        ],
        role: 'user'
      }
    ]
  })
}

export async function provideInferenceFeedback<T>(
  tensorZeroBaseUrl: string,
  metricName: string,
  inferenceId: string,
  value: T,
  tags?: TensorZeroGithubCiBotFeedbackTags
): Promise<void> {
  const feedbackUrl = `${tensorZeroBaseUrl}/feedback`
  const feedbackRequest: TensorZeroFeedbackRequest<T> = {
    metric_name: metricName,
    inference_id: inferenceId,
    value,
    tags
  }
  core.info(`Feedback Request: ${JSON.stringify(feedbackRequest, null, 2)}`)
  const response = await fetch(feedbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(feedbackRequest)
  })
  if (!response.ok) {
    throw new Error(`Failed to provide feedback: ${response.statusText}`)
  }
}

export async function provideEpisodeFeedback<T>(
  tensorZeroBaseUrl: string,
  metricName: string,
  episodeId: string,
  value: T,
  tags?: TensorZeroGithubCiBotFeedbackTags
): Promise<void> {
  const feedbackUrl = `${tensorZeroBaseUrl}/feedback`
  const feedbackRequest: TensorZeroEpisodeFeedbackRequest<T> = {
    metric_name: metricName,
    episode_id: episodeId,
    value,
    tags
  }
  core.info(
    `Episode Feedback Request: ${JSON.stringify(feedbackRequest, null, 2)}`
  )
  const response = await fetch(feedbackUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(feedbackRequest)
  })
  if (!response.ok) {
    throw new Error(
      `Failed to provide episode feedback: ${response.statusText}`
    )
  }
}
