import Handlebars from 'handlebars'

const commentTemplateString = `
### TensorZero CI Bot Automated Comment

{{#if generatedCommentBody}}
{{generatedCommentBody}}
{{/if}}

{{#if commands}}
Try running the following commands to address the issues:

\`\`\`
{{#each commands}}
{{this}}
{{/each}}
\`\`\`
{{/if}}

{{#if followupPrNumber}}
I've opened an automated follow-up PR #{{followupPrNumber}} with proposed fixes.
{{/if}}
{{#if followupPrCreationError}}
> [!WARNING]
> I encountered an error while trying to create a follow-up PR: {{followupPrCreationError}}.

{{#if generatedPatch}}
The patch I tried to generate is as follows:
\`\`\`diff
{{generatedPatch}}
\`\`\`
{{else}}
No patch was generated.
{{/if}}
{{/if}}
`

export interface CommentTemplateContext {
  generatedCommentBody?: string
  followupPrNumber?: number
  commands?: string[]
  followupPrCreationError?: string
  generatedPatch?: string
}

const commentTemplate = Handlebars.compile<CommentTemplateContext>(
  commentTemplateString.trim()
)

export function renderComment(
  commentContext: CommentTemplateContext
): string | undefined {
  if (
    !commentContext.generatedCommentBody &&
    !commentContext.followupPrCreationError &&
    !commentContext.followupPrNumber &&
    !commentContext.commands
  ) {
    return undefined
  }
  return commentTemplate(commentContext).trim()
}
