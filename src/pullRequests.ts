/**
 * High-level GitHub pull request operations.
 *
 * This module provides functions for working with GitHub pull requests, including:
 * - Creating follow-up PRs with automated fixes based on LLM-generated diffs
 * - Fetching failed workflow run logs using the GitHub CLI
 *
 * These functions orchestrate git operations (from git.ts) and GitHub API calls
 * to implement complete PR workflows. Use this module for PR-related business logic
 * rather than low-level git operations.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import * as fsPromises from 'fs/promises'
import * as path from 'path'
import * as core from '@actions/core'
import { clonePullRequestRepository as cloneRepo } from './git.js'

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

  const { repoDir, cleanup, git } = await cloneRepo(
    token,
    owner,
    repo,
    pullRequest
  )
  try {
    const fixBranchName = `tensorzero/pr-${pullRequest.number}-${Date.now()}`
    await git.checkoutNewBranch(fixBranchName)

    const patchPath = path.join(repoDir, 'tensorzero.patch')
    await fsPromises.writeFile(
      patchPath,
      `${trimmedDiff}
`,
      { encoding: 'utf-8' }
    )
    try {
      await git.applyPatch(patchPath)
    } finally {
      await fsPromises.rm(patchPath, { force: true })
    }

    const status = await git.status()
    if (!status.trim()) {
      core.warning(
        'Diff did not produce any changes; skipping follow-up PR creation.'
      )
      return undefined
    }

    await git.config('user.email', 'hello@tensorzero.com')
    await git.config('user.name', 'TensorZero-Experimental-CI-Bot[bot]')
    await git.addAll()
    await git.commit(`chore: automated fix for PR #${pullRequest.number}`)
    await git.push(fixBranchName)

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
