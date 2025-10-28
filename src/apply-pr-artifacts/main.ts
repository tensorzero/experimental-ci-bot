import * as core from '@actions/core'
import * as github from '@actions/github'
import * as fs from 'fs'
import * as path from 'path'

import {
  createFollowupPr,
  type FollowupPrResult,
  type PullRequestData,
  type CreateFollowupPrOptions
} from '../gitClient.js'
import {
  assertPullRequestPatchManifest,
  PATCH_MANIFEST_SCHEMA_VERSION,
  type PullRequestPatchManifest
} from '../artifacts/pullRequestPatchManifest.js'
import {
  createPullRequestToInferenceRecord,
  type ClickHouseConfig
} from '../clickhouseClient.js'
import { provideInferenceFeedback } from '../tensorZeroClient.js'
import { renderComment } from '../generate-pr-patch/pullRequestCommentTemplate.js'

const MAX_DIFF_CHAR_LENGTH = 500_000
const MAX_COMMENT_CHAR_LENGTH = 25_000
const MAX_COMMAND_COUNT = 25
const MAX_COMMAND_CHAR_LENGTH = 2_000

interface ApplyArtifactsInputs {
  token: string
  artifactDirectory: string
  manifestPath: string
  tensorZeroBaseUrl: string
  tensorZeroDiffPatchedSuccessfullyMetricName: string
  clickhouse: ClickHouseConfig
}

function parseInputs(): ApplyArtifactsInputs {
  const token = core.getInput('token')?.trim()
  if (!token) {
    throw new Error('A GitHub token is required via the `token` input.')
  }

  const artifactDirectory = core.getInput('artifact-directory')?.trim()
  if (!artifactDirectory) {
    throw new Error(
      'Artifact directory is required via the `artifact-directory` input.'
    )
  }

  const manifestPath = core.getInput('manifest-path')?.trim() || 'manifest.json'

  const tensorZeroBaseUrl = core.getInput('tensorzero-base-url')?.trim()
  if (!tensorZeroBaseUrl) {
    throw new Error(
      'TensorZero base url is required via the `tensorzero-base-url` input.'
    )
  }

  const tensorZeroDiffPatchedSuccessfullyMetricName = core
    .getInput('tensorzero-diff-patched-successfully-metric-name')
    ?.trim()
  if (!tensorZeroDiffPatchedSuccessfullyMetricName) {
    throw new Error(
      'TensorZero metric name is required via the `tensorzero-diff-patched-successfully-metric-name` input.'
    )
  }

  const clickhouseUrl = core.getInput('clickhouse-url')?.trim()
  if (!clickhouseUrl) {
    throw new Error(
      'ClickHouse URL is required via the `clickhouse-url` input.'
    )
  }
  const clickhouseTable = core.getInput('clickhouse-table')?.trim()
  if (!clickhouseTable) {
    throw new Error(
      'ClickHouse table name is required via the `clickhouse-table` input.'
    )
  }

  return {
    token,
    artifactDirectory,
    manifestPath,
    tensorZeroBaseUrl,
    tensorZeroDiffPatchedSuccessfullyMetricName,
    clickhouse: {
      url: clickhouseUrl,
      table: clickhouseTable
    }
  }
}

function resolveArtifactPath(baseDir: string, relativePath: string): string {
  const normalized = path.posix.normalize(relativePath)
  if (normalized.startsWith('../') || path.isAbsolute(normalized)) {
    throw new Error(`Artifact path escapes base directory: ${relativePath}`)
  }
  const base = path.resolve(baseDir)
  const resolved = path.resolve(baseDir, normalized)
  if (!resolved.startsWith(`${base}${path.sep}`) && resolved !== base) {
    throw new Error(`Artifact path escapes base directory: ${relativePath}`)
  }
  return resolved
}

function readOptionalTextFile(absolutePath: string): string | undefined {
  if (!fs.existsSync(absolutePath)) {
    return undefined
  }
  return fs.readFileSync(absolutePath, 'utf-8')
}

function parseCommands(commandsPath: string | undefined): string[] {
  if (!commandsPath) {
    return []
  }

  const rawContent = readOptionalTextFile(commandsPath)
  if (!rawContent) {
    return []
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawContent)
  } catch (error) {
    throw new Error(
      `Failed to parse commands JSON: ${(error as Error).message}`
    )
  }

  if (!Array.isArray(parsed)) {
    throw new Error('Commands JSON must be an array of strings.')
  }

  if (parsed.length > MAX_COMMAND_COUNT) {
    throw new Error(
      `Commands array exceeds maximum of ${MAX_COMMAND_COUNT} entries.`
    )
  }

  const commands: string[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'string') {
      throw new Error('Commands JSON must contain only strings.')
    }
    const trimmed = entry.trim()
    if (trimmed.length === 0) {
      continue
    }
    if (trimmed.length > MAX_COMMAND_CHAR_LENGTH) {
      throw new Error(
        `Command exceeds maximum length of ${MAX_COMMAND_CHAR_LENGTH} characters.`
      )
    }
    commands.push(trimmed)
  }

  return commands
}

function ensureDiffIsSafe(diff: string): string {
  const trimmed = diff.trim()
  if (!trimmed) {
    return ''
  }
  if (trimmed.length > MAX_DIFF_CHAR_LENGTH) {
    throw new Error(
      `Generated diff exceeds safe length of ${MAX_DIFF_CHAR_LENGTH} characters.`
    )
  }
  return trimmed
}

function ensureCommentIsSafe(comment: string | undefined): string {
  if (!comment) {
    return ''
  }
  const trimmed = comment.trim()
  if (trimmed.length > MAX_COMMENT_CHAR_LENGTH) {
    throw new Error(
      `Generated comment exceeds safe length of ${MAX_COMMENT_CHAR_LENGTH} characters.`
    )
  }
  return trimmed
}

function ensureWorkflowContextMatchesManifest(
  manifest: PullRequestPatchManifest
): void {
  const workflowRun = github.context.payload.workflow_run
  if (!workflowRun) {
    throw new Error('This action is expected to run on a workflow_run event.')
  }

  if (manifest.workflowRun.id !== workflowRun.id) {
    throw new Error(
      `Manifest workflow run ${manifest.workflowRun.id} does not match triggering workflow run ${workflowRun.id}.`
    )
  }

  const upstreamPrNumber = workflowRun.pull_requests?.[0]?.number
  if (!upstreamPrNumber) {
    throw new Error('Upstream workflow run did not reference a pull request.')
  }

  if (manifest.pullRequest.number !== upstreamPrNumber) {
    throw new Error(
      `Manifest PR #${manifest.pullRequest.number} does not match upstream PR #${upstreamPrNumber}.`
    )
  }
}

async function fetchAuthoritativePullRequest(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<PullRequestData> {
  const octokit = github.getOctokit(token)
  const response = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber
  })
  return response.data
}

function verifyPullRequestHasNotChanged(
  manifest: PullRequestPatchManifest,
  pullRequest: PullRequestData
): void {
  if (pullRequest.head.sha !== manifest.pullRequest.headSha) {
    throw new Error(
      `Pull request head SHA has changed (was ${manifest.pullRequest.headSha}, now ${pullRequest.head.sha}). Aborting.`
    )
  }

  if (pullRequest.base.sha !== manifest.pullRequest.baseSha) {
    throw new Error(
      `Pull request base SHA has changed (was ${manifest.pullRequest.baseSha}, now ${pullRequest.base.sha}). Aborting.`
    )
  }
}

async function attemptFollowupPrCreation(
  options: CreateFollowupPrOptions & {
    tensorZeroBaseUrl: string
    tensorZeroDiffMetric: string
    inferenceId: string
  }
): Promise<{ result?: FollowupPrResult; error?: string }> {
  try {
    const followupPr = await createFollowupPr(
      {
        octokit: options.octokit,
        token: options.token,
        owner: options.owner,
        repo: options.repo,
        pullRequest: options.pullRequest,
        diff: options.diff
      },
      undefined
    )
    await provideInferenceFeedback(
      options.tensorZeroBaseUrl,
      options.tensorZeroDiffMetric,
      options.inferenceId,
      true
    )
    return { result: followupPr }
  } catch (error) {
    const message = error instanceof Error ? error.message : `${error}`
    await provideInferenceFeedback(
      options.tensorZeroBaseUrl,
      options.tensorZeroDiffMetric,
      options.inferenceId,
      false,
      { reason: 'Failed to Apply Patch' }
    )
    core.error(`Failed to create follow-up PR: ${message}`)
    return { error: message }
  }
}

async function recordInferenceMapping(
  followupPr: FollowupPrResult,
  manifest: PullRequestPatchManifest,
  clickhouse: ClickHouseConfig
): Promise<void> {
  if (!manifest.llm.episodeId) {
    core.warning(
      'Episode ID missing from manifest; skipping ClickHouse logging.'
    )
    return
  }

  try {
    await createPullRequestToInferenceRecord(
      {
        inferenceId: manifest.llm.inferenceId,
        episodeId: manifest.llm.episodeId,
        pullRequestId: followupPr.id,
        originalPullRequestUrl: manifest.pullRequest.htmlUrl ?? ''
      },
      clickhouse
    )
    core.info(
      `Recorded inference ${manifest.llm.inferenceId} for follow-up PR #${followupPr.number}.`
    )
  } catch (error) {
    core.warning(
      `Failed to record inference mapping: ${error instanceof Error ? error.message : error}`
    )
  }
}

export async function run(): Promise<void> {
  const inputs = parseInputs()
  const {
    token,
    artifactDirectory,
    manifestPath,
    tensorZeroBaseUrl,
    tensorZeroDiffPatchedSuccessfullyMetricName,
    clickhouse
  } = inputs

  const absoluteArtifactDir = path.resolve(artifactDirectory)
  if (!fs.existsSync(absoluteArtifactDir)) {
    throw new Error(`Artifact directory does not exist: ${absoluteArtifactDir}`)
  }

  const manifestAbsolutePath = resolveArtifactPath(
    absoluteArtifactDir,
    manifestPath
  )
  core.info(`Reading manifest from ${manifestAbsolutePath}`)
  if (!fs.existsSync(manifestAbsolutePath)) {
    throw new Error(`Manifest file not found at ${manifestAbsolutePath}`)
  }

  let manifestRaw: string
  try {
    manifestRaw = fs.readFileSync(manifestAbsolutePath, 'utf-8')
  } catch (error) {
    throw new Error(
      `Failed to read manifest: ${error instanceof Error ? error.message : error}`
    )
  }

  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(manifestRaw)
  } catch (error) {
    throw new Error(
      `Failed to parse manifest JSON: ${error instanceof Error ? error.message : error}`
    )
  }

  assertPullRequestPatchManifest(manifestJson)
  const manifest = manifestJson
  if (manifest.schemaVersion !== PATCH_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported manifest schema version: ${manifest.schemaVersion}`
    )
  }

  ensureWorkflowContextMatchesManifest(manifest)

  const { owner, repo } = github.context.repo
  if (
    manifest.repository.owner !== owner ||
    manifest.repository.name !== repo
  ) {
    throw new Error(
      `Manifest repository ${manifest.repository.owner}/${manifest.repository.name} does not match workflow repository ${owner}/${repo}.`
    )
  }

  const pullRequest = await fetchAuthoritativePullRequest(
    token,
    owner,
    repo,
    manifest.pullRequest.number
  )
  verifyPullRequestHasNotChanged(manifest, pullRequest)

  const diffPathRelative =
    manifest.outputs.generatedPatchPath ?? 'generated-patch.diff'
  const diffAbsolutePath = resolveArtifactPath(
    absoluteArtifactDir,
    diffPathRelative
  )
  const diffContent = ensureDiffIsSafe(
    readOptionalTextFile(diffAbsolutePath) ?? ''
  )

  const commentPathRelative =
    manifest.outputs.generatedCommentPath ?? 'generated-comment.md'
  const commentAbsolutePath = resolveArtifactPath(
    absoluteArtifactDir,
    commentPathRelative
  )
  const generatedCommentBody = ensureCommentIsSafe(
    readOptionalTextFile(commentAbsolutePath)
  )

  const commandsPathRelative = manifest.outputs.commandsPath
    ? resolveArtifactPath(absoluteArtifactDir, manifest.outputs.commandsPath)
    : undefined
  const commands = parseCommands(commandsPathRelative)

  let followupPr: FollowupPrResult | undefined
  let followupPrError: string | undefined

  if (diffContent) {
    const followupResult = await attemptFollowupPrCreation({
      octokit: github.getOctokit(token),
      token,
      owner,
      repo,
      pullRequest,
      diff: diffContent,
      tensorZeroBaseUrl,
      tensorZeroDiffMetric: tensorZeroDiffPatchedSuccessfullyMetricName,
      inferenceId: manifest.llm.inferenceId
    })
    followupPr = followupResult.result
    followupPrError = followupResult.error

    if (followupPr) {
      await recordInferenceMapping(followupPr, manifest, clickhouse)
    }
  } else {
    core.info('No diff present in artifact; skipping follow-up PR creation.')
  }

  const comment = renderComment({
    generatedCommentBody,
    generatedPatch: diffContent,
    commands,
    followupPrNumber: followupPr?.number,
    followupPrCreationError: followupPrError
  })

  if (comment) {
    const octokit = github.getOctokit(token)
    try {
      await octokit.rest.issues.createComment({
        owner,
        repo,
        issue_number: manifest.pullRequest.number,
        body: comment
      })
      core.info(
        `Posted diagnostic comment to pull request #${manifest.pullRequest.number}.`
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : `${error}`
      core.warning(`Failed to comment on pull request: ${message}`)
    }
  } else {
    core.info('No comment generated from artifact; skipping PR comment.')
  }

  if (followupPr) {
    core.setOutput('followup-pr-number', followupPr.number)
    core.setOutput('followup-pr-url', followupPr.htmlUrl)
  }
}
