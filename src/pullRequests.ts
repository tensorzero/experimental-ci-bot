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
import type { GitClient } from './git.js'

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

export interface CreateFollowupPrFromWorkingDirOptions {
  octokit: OctokitInstance
  owner: string
  repo: string
  pullRequest: PullRequestData
  git: GitClient
  reasoning?: string
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

/**
 * Create a follow-up PR directly from the working directory where changes were made
 * This avoids the double-clone bug and patch application issues
 */
export async function createFollowupPrFromWorkingDir(
  {
    octokit,
    owner,
    repo,
    pullRequest,
    git,
    reasoning
  }: CreateFollowupPrFromWorkingDirOptions,
  outputDir?: string
): Promise<FollowupPrResult | undefined> {
  // Check if this is a fork PR (we can't push to forks)
  if (pullRequest.base.repo?.id !== pullRequest.head.repo?.id) {
    core.warning(
      'Original PR branch lives in a fork; skipping follow-up PR creation.'
    )
    return undefined
  }

  // Check for changes
  const status = await git.status()
  if (!status.trim()) {
    core.info('No changes to commit; skipping follow-up PR creation.')
    return undefined
  }

  // Create a new branch for the fix
  const fixBranchName = `tensorzero/pr-${pullRequest.number}-${Date.now()}`
  core.info(`Creating new branch: ${fixBranchName}`)
  await git.checkoutNewBranch(fixBranchName)

  // Configure git user
  await git.config('user.email', 'hello@tensorzero.com')
  await git.config('user.name', 'TensorZero-Experimental-CI-Bot[bot]')

  // Commit all changes
  await git.addAll()
  await git.commit(`chore: automated fix for PR #${pullRequest.number}`)

  // Push to remote
  core.info(`Pushing branch ${fixBranchName} to origin`)
  await git.push(fixBranchName)

  // Create the pull request
  const prTitle = `Automated follow-up for #${pullRequest.number}`
  const prBodyLines = [
    `This pull request was generated automatically in response to failing CI on #${pullRequest.number}.`,
    '',
    'The proposed changes were produced by mini-swe-agent running directly in the repository.'
  ]

  // Add reasoning if available
  if (reasoning && reasoning.trim()) {
    prBodyLines.push('')
    prBodyLines.push('## Fix Details')
    prBodyLines.push('')
    prBodyLines.push(reasoning.trim())
  }

  const prBody = prBodyLines.join('\n')

  core.info(`Creating PR: ${prTitle}`)
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
}

export async function getFailedWorkflowRunLogs(
  workflowRunId: number,
  owner?: string,
  repo?: string
): Promise<string> {
  // Validate that owner and repo are provided
  if (!owner || !repo) {
    throw new Error(
      'Owner and repo are required to fetch workflow run logs via API'
    )
  }

  try {
    // First, fetch the list of jobs for this workflow run
    const jobsArgs = [
      'api',
      `repos/${owner}/${repo}/actions/runs/${workflowRunId}/jobs`,
      '--paginate'
    ]

    const { stdout: jobsOutput } = await execFileAsync('gh', jobsArgs, {
      maxBuffer: 20 * 1024 * 1024,
      encoding: 'utf-8'
    })

    const jobsData = JSON.parse(jobsOutput)
    const jobs = jobsData.jobs || []

    // Filter to failed jobs
    const failedJobs = jobs.filter(
      (job: any) => job.conclusion && job.conclusion !== 'success'
    )

    if (failedJobs.length === 0) {
      core.warning(`No failed jobs found for workflow run ${workflowRunId}`)
      return ''
    }

    // Fetch logs for each failed job
    const logPromises = failedJobs.map(async (job: any) => {
      try {
        const logsArgs = [
          'api',
          `repos/${owner}/${repo}/actions/jobs/${job.id}/logs`,
          '--paginate'
        ]

        const { stdout: logs } = await execFileAsync('gh', logsArgs, {
          maxBuffer: 20 * 1024 * 1024,
          encoding: 'utf-8'
        })

        return `\n=== Job: ${job.name} (ID: ${job.id}) ===\n${logs}\n`
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : `${error}`
        core.warning(
          `Failed to fetch logs for job ${job.name} (${job.id}): ${errorMessage}`
        )
        return `\n=== Job: ${job.name} (ID: ${job.id}) ===\n[Failed to fetch logs: ${errorMessage}]\n`
      }
    })

    const allLogs = await Promise.all(logPromises)
    const combinedLogs = allLogs.join('\n')

    if (!combinedLogs.trim()) {
      throw new Error(`Did not receive any logs for workflow ${workflowRunId}`)
    }

    return combinedLogs
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : `${error}`
    throw new Error(`Failed to fetch workflow run logs: ${errorMessage}`)
  }
}

/**
 * Find the most recent failed workflow run for a specific commit SHA
 */
export async function findLatestFailedWorkflowRun(
  octokit: OctokitInstance,
  owner: string,
  repo: string,
  headSha: string
): Promise<number | undefined> {
  try {
    // Query workflow runs for this commit
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      head_sha: headSha,
      per_page: 100 // Get up to 100 runs for this commit
    })

    // Filter to failed runs and sort by created_at descending
    const failedRuns = data.workflow_runs
      .filter((run) => run.conclusion === 'failure')
      .sort(
        (a, b) =>
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      )

    if (failedRuns.length === 0) {
      return undefined
    }

    return failedRuns[0].id
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : `${error}`
    core.warning(`Failed to query workflow runs: ${errorMessage}`)
    return undefined
  }
}
