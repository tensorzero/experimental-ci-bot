import { renderComment } from './pullRequestCommentTemplate.js'

describe('renderComment', () => {
  it('returns undefined when comment body is absent', () => {
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
})
