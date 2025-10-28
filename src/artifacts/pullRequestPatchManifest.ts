export const PATCH_MANIFEST_SCHEMA_VERSION = 1 as const

export interface PullRequestPatchManifest {
  schemaVersion: typeof PATCH_MANIFEST_SCHEMA_VERSION
  artifactVersion: string
  createdAt: string
  workflowRun: {
    id: number
    attempt?: number
    name?: string
    headBranch?: string
  }
  repository: {
    owner: string
    name: string
  }
  pullRequest: {
    number: number
    headSha: string
    headRef: string
    baseSha: string
    baseRef: string
    htmlUrl?: string
    headRepositoryId?: number
    baseRepositoryId?: number
    author?: {
      login?: string
      id?: number
    }
  }
  outputs: {
    generatedPatchPath?: string
    generatedCommentPath?: string
    commandsPath?: string
    llmResponsePath?: string
    failureLogsPath?: string
    workflowJobsPath?: string
  }
  llm: {
    inferenceId: string
    responseId: string
    episodeId?: string
  }
  tensorZero: {
    diffPatchedMetricName: string
  }
  metadata: {
    hasDiff: boolean
    hasComment: boolean
    hasCommands: boolean
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertString(
  value: unknown,
  message: string
): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(message)
  }
}

function assertNumber(
  value: unknown,
  message: string
): asserts value is number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(message)
  }
}

function assertBoolean(
  value: unknown,
  message: string
): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(message)
  }
}

export function assertPullRequestPatchManifest(
  value: unknown
): asserts value is PullRequestPatchManifest {
  if (!isObject(value)) {
    throw new Error('Manifest must be an object')
  }

  const {
    schemaVersion,
    artifactVersion,
    createdAt,
    workflowRun,
    repository,
    pullRequest,
    outputs,
    llm,
    tensorZero,
    metadata
  } = value

  if (schemaVersion !== PATCH_MANIFEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported manifest schema version: ${schemaVersion as string}`
    )
  }

  assertString(artifactVersion, 'Manifest artifactVersion must be a string')
  assertString(createdAt, 'Manifest createdAt must be a string')

  if (!isObject(workflowRun)) {
    throw new Error('Manifest workflowRun must be an object')
  }
  assertNumber(workflowRun.id, 'Manifest workflowRun.id must be a number')
  if (workflowRun.attempt !== undefined) {
    assertNumber(
      workflowRun.attempt,
      'Manifest workflowRun.attempt must be a number when provided'
    )
  }
  if (workflowRun.name !== undefined) {
    assertString(
      workflowRun.name,
      'Manifest workflowRun.name must be a string when provided'
    )
  }
  if (workflowRun.headBranch !== undefined) {
    assertString(
      workflowRun.headBranch,
      'Manifest workflowRun.headBranch must be a string when provided'
    )
  }

  if (!isObject(repository)) {
    throw new Error('Manifest repository must be an object')
  }
  assertString(repository.owner, 'Manifest repository.owner must be a string')
  assertString(repository.name, 'Manifest repository.name must be a string')

  if (!isObject(pullRequest)) {
    throw new Error('Manifest pullRequest must be an object')
  }
  assertNumber(
    pullRequest.number,
    'Manifest pullRequest.number must be a number'
  )
  assertString(
    pullRequest.headSha,
    'Manifest pullRequest.headSha must be a string'
  )
  assertString(
    pullRequest.headRef,
    'Manifest pullRequest.headRef must be a string'
  )
  assertString(
    pullRequest.baseSha,
    'Manifest pullRequest.baseSha must be a string'
  )
  assertString(
    pullRequest.baseRef,
    'Manifest pullRequest.baseRef must be a string'
  )
  if (pullRequest.htmlUrl !== undefined) {
    assertString(
      pullRequest.htmlUrl,
      'Manifest pullRequest.htmlUrl must be a string when provided'
    )
  }
  if (pullRequest.headRepositoryId !== undefined) {
    assertNumber(
      pullRequest.headRepositoryId,
      'Manifest pullRequest.headRepositoryId must be a number when provided'
    )
  }
  if (pullRequest.baseRepositoryId !== undefined) {
    assertNumber(
      pullRequest.baseRepositoryId,
      'Manifest pullRequest.baseRepositoryId must be a number when provided'
    )
  }
  if (pullRequest.author !== undefined) {
    if (!isObject(pullRequest.author)) {
      throw new Error(
        'Manifest pullRequest.author must be an object when provided'
      )
    }
    if (pullRequest.author.login !== undefined) {
      assertString(
        pullRequest.author.login,
        'Manifest pullRequest.author.login must be a string when provided'
      )
    }
    if (pullRequest.author.id !== undefined) {
      assertNumber(
        pullRequest.author.id,
        'Manifest pullRequest.author.id must be a number when provided'
      )
    }
  }

  if (!isObject(outputs)) {
    throw new Error('Manifest outputs must be an object')
  }
  const outputKeys: Array<keyof typeof outputs> = [
    'generatedPatchPath',
    'generatedCommentPath',
    'commandsPath',
    'llmResponsePath',
    'failureLogsPath',
    'workflowJobsPath'
  ]
  for (const key of outputKeys) {
    if (outputs[key] !== undefined) {
      assertString(
        outputs[key],
        `Manifest outputs.${key as string} must be a string when provided`
      )
    }
  }

  if (!isObject(llm)) {
    throw new Error('Manifest llm must be an object')
  }
  assertString(llm.inferenceId, 'Manifest llm.inferenceId must be a string')
  assertString(llm.responseId, 'Manifest llm.responseId must be a string')
  if (llm.episodeId !== undefined) {
    assertString(
      llm.episodeId,
      'Manifest llm.episodeId must be a string when provided'
    )
  }

  if (!isObject(tensorZero)) {
    throw new Error('Manifest tensorZero must be an object')
  }
  assertString(
    tensorZero.diffPatchedMetricName,
    'Manifest tensorZero.diffPatchedMetricName must be a string'
  )

  if (!isObject(metadata)) {
    throw new Error('Manifest metadata must be an object')
  }
  assertBoolean(metadata.hasDiff, 'Manifest metadata.hasDiff must be a boolean')
  assertBoolean(
    metadata.hasComment,
    'Manifest metadata.hasComment must be a boolean'
  )
  assertBoolean(
    metadata.hasCommands,
    'Manifest metadata.hasCommands must be a boolean'
  )
}
