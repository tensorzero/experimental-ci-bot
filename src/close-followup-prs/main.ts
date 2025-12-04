import * as core from '@actions/core'
import * as github from '@actions/github'
import type {
  CloseFollowupPrsActionInput,
  FollowupPrInfo,
  CloseFollowupPrsResult
} from './types.js'

function parseAndValidateActionInputs(): CloseFollowupPrsActionInput {
  const githubToken = core.getInput('github-token')?.trim()
  if (!githubToken) {
    throw new Error(
      'GitHub token is required; provide one via the `github-token` input.'
    )
  }
  return { githubToken }
}

/**
 * Find all open follow-up PRs that target the given base PR's head branch
 * and were created by the bot for this specific PR.
 */
async function findFollowupPrs(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  basePrNumber: number,
  basePrHeadRef: string
): Promise<FollowupPrInfo[]> {
  const { data: prs } = await octokit.rest.pulls.list({
    owner,
    repo,
    base: basePrHeadRef,
    state: 'open'
  })

  const followupPrs: FollowupPrInfo[] = []

  for (const pr of prs) {
    // Match branch pattern: tensorzero/pr-{number}-{timestamp}
    const branchMatch = pr.head.ref.match(/^tensorzero\/pr-(\d+)-\d+$/)
    if (!branchMatch) continue

    // Verify the PR number in the branch matches the base PR
    const prNumberInBranch = parseInt(branchMatch[1], 10)
    if (prNumberInBranch !== basePrNumber) continue

    followupPrs.push({
      number: pr.number,
      id: pr.id,
      htmlUrl: pr.html_url,
      headRef: pr.head.ref
    })
  }

  return followupPrs
}

/**
 * Close a follow-up PR with an explanatory comment
 */
async function closeFollowupPr(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  followupPr: FollowupPrInfo,
  basePrNumber: number,
  basePrMerged: boolean
): Promise<void> {
  const closeReason = basePrMerged
    ? `The base PR #${basePrNumber} has been merged.`
    : `The base PR #${basePrNumber} has been closed.`

  const commentBody = `## This PR has been automatically closed

${closeReason}

Since this follow-up PR was created to fix CI issues on #${basePrNumber}, it is no longer needed.

---
*Closed by TensorZero CI Bot*`

  await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: followupPr.number,
    body: commentBody
  })

  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: followupPr.number,
    state: 'closed'
  })

  // Delete the branch
  try {
    await octokit.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${followupPr.headRef}`
    })
    core.info(`Deleted branch ${followupPr.headRef}`)
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : `${error}`
    core.warning(
      `Failed to delete branch ${followupPr.headRef}: ${errorMessage}`
    )
  }
}

/**
 * Find and close all follow-up PRs for a closed base PR
 */
async function closeFollowupPrsForBasePr(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  basePrNumber: number,
  basePrHeadRef: string,
  basePrMerged: boolean
): Promise<CloseFollowupPrsResult> {
  const result: CloseFollowupPrsResult = { closed: 0, errors: [] }

  const followupPrs = await findFollowupPrs(
    octokit,
    owner,
    repo,
    basePrNumber,
    basePrHeadRef
  )

  if (followupPrs.length === 0) {
    core.info(`No open follow-up PRs found for #${basePrNumber}`)
    return result
  }

  core.info(`Found ${followupPrs.length} follow-up PR(s) for #${basePrNumber}`)

  for (const followupPr of followupPrs) {
    try {
      await closeFollowupPr(
        octokit,
        owner,
        repo,
        followupPr,
        basePrNumber,
        basePrMerged
      )
      result.closed++
      core.info(`Closed follow-up PR #${followupPr.number}`)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : `${error}`
      result.errors.push(`PR #${followupPr.number}: ${errorMessage}`)
      core.warning(
        `Failed to close follow-up PR #${followupPr.number}: ${errorMessage}`
      )
    }
  }

  return result
}

export async function run(): Promise<void> {
  const inputs = parseAndValidateActionInputs()

  const pr = github.context.payload.pull_request
  if (!pr) {
    core.info('No pull request in context. Skipping.')
    return
  }

  const prState = pr.state as string | undefined
  if (prState !== 'closed') {
    core.info('Pull request is not closed. Skipping.')
    return
  }

  const prNumber = pr.number as number
  const prHeadRef = pr.head?.ref as string | undefined
  const prMerged = (pr.merged as boolean) ?? false

  if (!prHeadRef) {
    core.warning('Pull request head ref not found. Skipping.')
    return
  }

  core.info(
    `Processing closed PR #${prNumber} (merged: ${prMerged}, head: ${prHeadRef})`
  )

  const octokit = github.getOctokit(inputs.githubToken)
  const { owner, repo } = github.context.repo

  const result = await closeFollowupPrsForBasePr(
    octokit,
    owner,
    repo,
    prNumber,
    prHeadRef,
    prMerged
  )

  if (result.closed > 0) {
    core.info(`Successfully closed ${result.closed} follow-up PR(s)`)
  }

  if (result.errors.length > 0) {
    core.warning(`Errors closing some PRs: ${result.errors.join(', ')}`)
  }
}
