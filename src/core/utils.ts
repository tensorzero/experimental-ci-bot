import * as fs from 'fs'
import * as path from 'path'
import type { OctokitInstance } from '../generate-pr-patch/types.js'
import { PullRequestInfo } from './types.js'
import { getPullRequestDiff } from '../git.js'

export function maybeWriteDebugArtifact(
  outputDir: string | undefined,
  filename: string,
  content: string
): void {
  if (!outputDir) {
    return
  }
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true })
  }
  fs.writeFileSync(path.join(outputDir, filename), content, {
    encoding: 'utf-8'
  })
  console.log(
    `[Debug] ${filename} written to ${path.join(outputDir, filename)}`
  )
}

export async function fetchDiffSummaryAndFullDiff(
  octokit: OctokitInstance,
  pr: PullRequestInfo,
  token: string
): Promise<{
  diffSummary: string
  fullDiff: string
  prData: Awaited<ReturnType<OctokitInstance['rest']['pulls']['get']>>['data']
}> {
  console.log('[Agent Runner] Fetching PR diff via git...')
  const prResponse = await octokit.rest.pulls.get({
    owner: pr.owner,
    repo: pr.repo,
    pull_number: pr.number
  })

  const diffResult = await getPullRequestDiff(
    token,
    pr.owner,
    pr.repo,
    prResponse.data
  )

  return {
    diffSummary: diffResult.diffSummary,
    fullDiff: diffResult.fullDiff,
    prData: prResponse.data
  }
}
