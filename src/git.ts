import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git'
import * as fsPromises from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as core from '@actions/core'

export interface PullRequestData {
  head: {
    ref: string
    sha: string
  }
  base: {
    ref: string
  }
}

export interface ClonedRepository {
  repoDir: string
  cleanup: () => Promise<void>
  git: GitClient
}

export interface DiffResult {
  diffSummary: string
  fullDiff: string
}

function maskSecret(value: string, secret: string | undefined): string {
  if (!secret || !value) {
    return value
  }
  return value.split(secret).join('***')
}

export class GitClient {
  private git: SimpleGit
  private token?: string

  constructor(cwd: string, token?: string) {
    const options: Partial<SimpleGitOptions> = {
      baseDir: cwd,
      binary: 'git',
      maxConcurrentProcesses: 6,
      trimmed: false,
      config: [
        'core.quotepath=false' // Prevent escaping of non-ASCII characters
      ]
    }

    this.git = simpleGit(options)
    this.token = token

    // Set large buffer for diffs
    this.git.env('GIT_TERMINAL_PROMPT', '0')
  }

  private logCommand(command: string): void {
    const masked = this.token ? maskSecret(command, this.token) : command
    core.info(`git ${masked}`)
  }

  private maskError(error: Error): Error {
    if (!this.token) return error
    const maskedMessage = maskSecret(error.message, this.token)
    return new Error(maskedMessage)
  }

  async clone(
    remoteUrl: string,
    targetDir: string,
    branch: string
  ): Promise<void> {
    this.logCommand(`clone --origin origin --branch ${branch} [URL] ${targetDir}`)
    try {
      await this.git.clone(remoteUrl, targetDir, [
        '--origin',
        'origin',
        '--branch',
        branch
      ])
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async fetch(ref: string): Promise<void> {
    this.logCommand(`fetch origin ${ref}`)
    try {
      await this.git.fetch(['origin', ref])
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async diff(range?: string, options?: { stat?: boolean; unified?: number }): Promise<string> {
    const args: string[] = []

    if (options?.stat) {
      args.push('--stat')
    }
    if (options?.unified !== undefined) {
      args.push(`--unified=${options.unified}`)
    }
    if (range) {
      args.push(range)
    }

    const command = `diff ${args.join(' ')}`
    this.logCommand(command)

    try {
      const result = await this.git.diff(args)
      return result
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async checkoutNewBranch(branchName: string): Promise<void> {
    this.logCommand(`checkout -b ${branchName}`)
    try {
      await this.git.checkoutLocalBranch(branchName)
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async applyPatch(patchPath: string): Promise<void> {
    this.logCommand(`apply --whitespace=nowarn ${patchPath}`)
    try {
      await this.git.raw(['apply', '--whitespace=nowarn', patchPath])
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async status(): Promise<string> {
    this.logCommand('status --porcelain')
    try {
      const result = await this.git.status(['--porcelain'])
      return result.files.map(f => `${f.index}${f.working_dir} ${f.path}`).join('\n')
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async config(key: string, value: string): Promise<void> {
    this.logCommand(`config ${key} ${value}`)
    try {
      await this.git.addConfig(key, value)
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async addAll(): Promise<void> {
    this.logCommand('add --all')
    try {
      await this.git.add('--all')
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async commit(message: string): Promise<void> {
    this.logCommand(`commit -m "${message}"`)
    try {
      await this.git.commit(message)
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async push(branchName: string): Promise<void> {
    this.logCommand(`push --set-upstream origin ${branchName}`)
    try {
      await this.git.push(['--set-upstream', 'origin', branchName])
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }

  async raw(args: string[]): Promise<string> {
    this.logCommand(args.join(' '))
    try {
      return await this.git.raw(args)
    } catch (error) {
      throw this.maskError(error as Error)
    }
  }
}

export async function clonePullRequestRepository(
  token: string,
  owner: string,
  repo: string,
  pullRequest: PullRequestData
): Promise<ClonedRepository> {
  const tempBaseDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'tensorzero-pr-')
  )
  const repoDir = path.join(tempBaseDir, 'repo')
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`

  // Create a temporary git client for cloning
  const tempGit = new GitClient(process.cwd(), token)

  try {
    await tempGit.clone(remoteUrl, repoDir, pullRequest.head.ref)
  } catch (error) {
    await fsPromises.rm(tempBaseDir, { recursive: true, force: true })
    throw error
  }

  // Create the actual git client for the cloned repo
  const git = new GitClient(repoDir, token)

  const cleanup = async (): Promise<void> => {
    await fsPromises.rm(tempBaseDir, { recursive: true, force: true })
  }

  return { repoDir, cleanup, git }
}

export async function getPullRequestDiff(
  token: string,
  owner: string,
  repo: string,
  pullRequest: PullRequestData
): Promise<DiffResult> {
  const { git, cleanup } = await clonePullRequestRepository(
    token,
    owner,
    repo,
    pullRequest
  )

  try {
    core.info(
      `Fetching base branch ${pullRequest.base.ref} for diff computation.`
    )
    await git.fetch(pullRequest.base.ref)

    core.info(
      `Ensuring head branch ${pullRequest.head.ref} is up to date for diff computation.`
    )
    await git.fetch(pullRequest.head.ref)

    const diffRange = `origin/${pullRequest.base.ref}...${pullRequest.head.sha}`

    core.info(`Computing diff summary with range ${diffRange}.`)
    const diffSummary = await git.diff(diffRange, { stat: true })

    core.info(`Computing full diff with range ${diffRange}.`)
    const fullDiff = await git.diff(diffRange)

    return {
      diffSummary,
      fullDiff
    }
  } finally {
    await cleanup()
  }
}
