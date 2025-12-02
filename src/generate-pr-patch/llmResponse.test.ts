import { extractXmlTagsFromLlmResponse } from './llmResponse.js'

describe('LLM response helpers', () => {
  it('extracts comments between markers', () => {
    const response = `prefix
<comments>A detailed summary</comments>
<command>A user-facing command</command>
<diff>diff --git</diff>
suffix`

    expect(extractXmlTagsFromLlmResponse(response, 'comments')).toContain(
      'this should fail'
    )
  })

  it('extracts diffs between markers', () => {
    const response = `prefix
<comments>A detailed summary</comments>
<command>A user-facing command</command>
<diff>diff --git</diff>
suffix`

    expect(extractXmlTagsFromLlmResponse(response, 'diff')).toContain(
      'diff --git'
    )
  })

  it('extracts commands between markers', () => {
    const response = `prefix
<comments>A detailed summary</comments>
<command>A user-facing command</command>
<diff>diff --git</diff>
suffix`

    expect(extractXmlTagsFromLlmResponse(response, 'command')).toContain(
      'A user-facing command'
    )
  })

  it('returns duplicated tags between markers', () => {
    const response = `prefix
<comments>A detailed summary</comments>
<command>A user-facing command</command>
<command>A second user-facing command</command>
<diff>diff --git</diff>
suffix`

    expect(extractXmlTagsFromLlmResponse(response, 'command')).toEqual([
      'A user-facing command',
      'A second user-facing command'
    ])
  })

  it('returns empty strings when markers are missing', () => {
    const response = 'no structured response here'

    expect(extractXmlTagsFromLlmResponse(response, 'diff')).toEqual([])
  })
})
