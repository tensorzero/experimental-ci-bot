import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fsPromises from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as core from '@actions/core'

const execFileAsync = promisify(execFile)

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

export interface PullRequestDiffOptions {
  token: string
  owner: string
  repo: string
  pullRequest: PullRequestData
}

export interface PullRequestDiffResult {
  diffSummary: string
  fullDiff: string
}

function maskSecret(value: string, secret: string | undefined): string {
  if (!secret || !value) {
    return value
  }
  return value.split(secret).join('***')
}

async function execGit(
  args: string[],
  options: { cwd?: string; token?: string } = {}
): Promise<{ stdout: string; stderr: string }> {
  const { cwd, token } = options
  const commandString = maskSecret(`git ${args.join(' ')}`, token)
  core.info(commandString)
  try {
    const result = await execFileAsync('git', args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0'
      },
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'utf-8'
    })
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? ''
    }
  } catch (error) {
    const err = error as { message: string; stdout?: string; stderr?: string }
    const stderr = err.stderr || err.stdout || err.message
    throw new Error(`${commandString} failed: ${maskSecret(stderr, token)}`)
  }
}

interface ClonedRepository {
  repoDir: string
  cleanup: () => Promise<void>
  remoteUrl: string
  maskedRemoteUrl: string
}

interface CloneRepositoryOptions {
  token: string
  owner: string
  repo: string
  pullRequest: PullRequestData
}

async function clonePullRequestRepository(
  options: CloneRepositoryOptions
): Promise<ClonedRepository> {
  const { token, owner, repo, pullRequest } = options
  const tempBaseDir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), 'tensorzero-pr-')
  )
  const repoDir = path.join(tempBaseDir, 'repo')
  const remoteUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
  const maskedRemoteUrl = maskSecret(remoteUrl, token)

  try {
    await execGit(
      [
        'clone',
        '--origin',
        'origin',
        '--branch',
        pullRequest.head.ref,
        remoteUrl,
        repoDir
      ],
      { token }
    )
  } catch (error) {
    await fsPromises.rm(tempBaseDir, { recursive: true, force: true })
    throw error
  }

  const cleanup = async (): Promise<void> => {
    await fsPromises.rm(tempBaseDir, { recursive: true, force: true })
  }

  return { repoDir, cleanup, remoteUrl, maskedRemoteUrl }
}

export async function createFollowupPr(
  { octokit, token, owner, repo, pullRequest, diff }: CreateFollowupPrOptions,
  outputDir?: string
): Promise<FollowupPrResult | undefined> {
  const trimmedDiff = diff.trim()
  if (!trimmedDiff) {
    core.info(
      'Diff content empty after trimming; skipping follow-up PR creation.'
    )
    return undefined
  }
  if (!pullRequest.base.repo?.id) {
    core.warning(
      'Cannot identify base PR repository; skipping follow-up PR creation.'
    )
    return undefined
  }
  if (pullRequest.head.repo?.id !== pullRequest.base.repo?.id) {
    core.warning(
      'Original PR branch lives in a fork; skipping follow-up PR creation.'
    )
    return undefined
  }

  const { repoDir, cleanup, maskedRemoteUrl } =
    await clonePullRequestRepository({
      token,
      owner,
      repo,
      pullRequest
    })
  try {
    const fixBranchName = `tensorzero/pr-${pullRequest.number}-${Date.now()}`
    await execGit(['checkout', '-b', fixBranchName], { cwd: repoDir, token })

    const patchPath = path.join(repoDir, 'tensorzero.patch')
    await fsPromises.writeFile(
      patchPath,
      `${trimmedDiff}
`,
      { encoding: 'utf-8' }
    )
    try {
      await execGit(['apply', '--whitespace=nowarn', patchPath], {
        cwd: repoDir,
        token
      })
    } finally {
      await fsPromises.rm(patchPath, { force: true })
    }

    const status = await execGit(['status', '--porcelain'], {
      cwd: repoDir,
      token
    })
    if (!status.stdout.trim()) {
      core.warning(
        'Diff did not produce any changes; skipping follow-up PR creation.'
      )
      return undefined
    }

    await execGit(['config', 'user.email', 'hello@tensorzero.com'], {
      cwd: repoDir,
      token
    })
    await execGit(
      ['config', 'user.name', 'TensorZero-Experimental-CI-Bot[bot]'],
      {
        cwd: repoDir,
        token
      }
    )
    await execGit(['add', '--all'], { cwd: repoDir, token })
    await execGit(
      ['commit', '-m', `chore: automated fix for PR #${pullRequest.number}`],
      {
        cwd: repoDir,
        token
      }
    )
    await execGit(['push', '--set-upstream', 'origin', fixBranchName], {
      cwd: repoDir,
      token
    })

    const prTitle = `Automated follow-up for #${pullRequest.number}`
    const prBodyLines = [
      `This pull request was generated automatically in response to failing CI on #${pullRequest.number}.`,
      '',
      'The proposed changes were produced from an LLM-provided diff.'
    ]
    const prBody = prBodyLines.join('\n')

    const createdPr = await octokit.rest.pulls.create({
      owner,
      repo,
      base: pullRequest.head.ref,
      head: fixBranchName,
      title: prTitle,
      body: prBody
    })

    if (outputDir) {
      await fsPromises.writeFile(
        path.join(outputDir, 'followup-pr-payload.json'),
        JSON.stringify(createdPr, null, 2)
      )
    }

    return {
      number: createdPr.data.number,
      id: createdPr.data.id,
      htmlUrl: createdPr.data.html_url
    }
  } catch (error) {
    const maskedMessage = maskSecret((error as Error).message, token)
    throw new Error(
      `Failed to create follow-up PR using remote ${maskedRemoteUrl}: ${maskedMessage}`
    )
  } finally {
    await cleanup()
  }
}

export async function getPullRequestDiff(
  options: PullRequestDiffOptions
): Promise<PullRequestDiffResult> {
  const { token, owner, repo, pullRequest } = options

  const { repoDir, cleanup, maskedRemoteUrl } =
    await clonePullRequestRepository({
      token,
      owner,
      repo,
      pullRequest
    })

  try {
    core.info(
      `Fetching base branch ${pullRequest.base.ref} for diff computation.`
    )
    await execGit(['fetch', 'origin', pullRequest.base.ref], {
      cwd: repoDir,
      token
    })

    core.info(
      `Ensuring head branch ${pullRequest.head.ref} is up to date for diff computation.`
    )
    await execGit(['fetch', 'origin', pullRequest.head.ref], {
      cwd: repoDir,
      token
    })

    const diffRange = `origin/${pullRequest.base.ref}...${pullRequest.head.sha}`
    core.info(`Computing diff summary with range ${diffRange}.`)
    const diffSummary = await execGit(['diff', '--stat', diffRange], {
      cwd: repoDir,
      token
    })
    core.info(`Computing full diff with range ${diffRange}.`)
    const fullDiff = await execGit(['diff', diffRange], {
      cwd: repoDir,
      token
    })

    return {
      diffSummary: diffSummary.stdout,
      fullDiff: fullDiff.stdout
    }
  } catch (error) {
    const maskedMessage = maskSecret((error as Error).message, token)
    throw new Error(
      `Failed to compute diff using remote ${maskedRemoteUrl}: ${maskedMessage}`
    )
  } finally {
    await cleanup()
  }
}

export async function getFailedWorkflowRunLogs(
  workflowRunId: number
): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    'gh',
    ['run', 'view', `${workflowRunId}`, '--log-failed'],
    {
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'utf-8'
    }
  )
  if (stderr) {
    core.warning(
      `Encountered stderr when getting failed workflow logs: ${stderr}`
    )
  }
  if (stdout) {
    return stdout
  }
  throw new Error(`Did not receive any logs for workflow ${workflowRunId}`)
}
