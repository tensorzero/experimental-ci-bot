import fs from 'fs'
import os from 'os'
import path from 'path'

import { renderComment } from './pullRequestCommentTemplate.js'

describe('renderComment', () => {
  it('returns undefined when nothing is absent', () => {
    expect(renderComment({})).toBeUndefined()
  })

  it('renders a comment block and follow-up PR details when provided', () => {
    const result = renderComment({
      generatedCommentBody: 'CI failed on the lint step',
      followupPrNumber: 123
    })

    expect(result).toContain('TensorZero CI Bot Automated Comment')
    expect(result).toContain('CI failed on the lint step')
    expect(result).toContain('follow-up PR #123')
  })

  it('trims extraneous whitespace from the rendered comment', () => {
    const result = renderComment({
      generatedCommentBody: '\nNeeds attention\n'
    })

    expect(result).not.toBeUndefined()
    expect(result).toContain('\n\nNeeds attention')
    expect(result?.trimEnd().endsWith('Needs attention')).toBe(true)
  })

  it('renders commands when provided', () => {
    const result = renderComment({
      generatedCommentBody: 'CI failed on the lint step',
      commands: ['npm install', 'npm run lint']
    })

    expect(result).toContain(
      'Try running the following commands to address the issues'
    )
    expect(result).toContain('npm install')
    expect(result).toContain('npm run lint')
  })

  it('renders errors when provided', () => {
    const result = renderComment({
      generatedCommentBody: 'CI failed on the lint step',
      followupPrCreationError: 'Authentication failed',
      generatedPatch: 'patch contents'
    })

    expect(result).toContain(
      'I encountered an error while trying to create a follow-up PR: Authentication failed.'
    )
    expect(result).toContain('The patch I tried to generate is as follows:')
    expect(result).toContain('patch contents')
  })

  it('renders the generated patch without HTML escaping', () => {
    const result = renderComment({
      generatedCommentBody: 'CI failed on the lint step',
      followupPrCreationError: 'Authentication failed',
      generatedPatch:
        'diff --git a/example.ts b/example.ts\n@@ -1,4 +1,4 @@\n-import { something } from "old"\n+import { something } from "new"'
    })

    expect(result).toContain('import { something } from "old"')
    expect(result).toContain('import { something } from "new"')
    expect(result).not.toContain('&quot;')
  })

  it('preserves quotes when the rendered comment is written to disk', () => {
    const result = renderComment({
      generatedCommentBody: 'CI failed on the lint step',
      followupPrCreationError: 'Authentication failed',
      generatedPatch:
        'diff --git a/example.ts b/example.ts\n@@ -1,4 +1,4 @@\n-import { something } from "old"\n+import { something } from "new"'
    })

    expect(result).toBeDefined()

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-test-'))
    try {
      const filePath = path.join(tmpDir, 'comment.md')
      fs.writeFileSync(filePath, result ?? '', { encoding: 'utf-8' })

      const fileContents = fs.readFileSync(filePath, { encoding: 'utf-8' })
      expect(fileContents).toContain('import { something } from "old"')
      expect(fileContents).toContain('import { something } from "new"')
      expect(fileContents).not.toContain('&quot;')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('does not render patch if passed', () => {
    const result = renderComment({
      generatedCommentBody: 'CI failed on the lint step',
      generatedPatch: 'patch contents'
    })

    expect(result).not.toContain('patch contents')
  })
})
