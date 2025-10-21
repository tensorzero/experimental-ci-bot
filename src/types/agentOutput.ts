/**
 * The decision made by the agent on how to present the fix
 */
export type AgentDecision = 'INLINE_SUGGESTIONS' | 'PULL_REQUEST'

/**
 * The parsed output from the agent's completion signal
 */
export interface AgentCompletionOutput {
  decision: AgentDecision
  reasoning: string
}

/**
 * Message in the agent's trajectory
 */
export interface AgentMessage {
  role: 'user' | 'assistant'
  content: string | Array<{ type: string; [key: string]: unknown }>
}

/**
 * Model statistics from the agent's execution
 */
export interface ModelStats {
  instance_cost: number
  api_calls: number
}

/**
 * Information about the agent's execution
 */
export interface AgentInfo {
  exit_status: string
  submission: string
  model_stats: ModelStats
  mini_version: string
  config?: unknown
}

/**
 * The full trajectory of the agent's execution
 */
export interface AgentTrajectory {
  info: AgentInfo
  messages: AgentMessage[]
}

/**
 * Parse the agent's completion output from the final command
 */
export function parseAgentCompletion(output: string): AgentCompletionOutput {
  const lines = output.trim().split('\n')

  let decision: AgentDecision | null = null
  let reasoning = ''

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (trimmedLine.startsWith('DECISION:')) {
      const decisionValue = trimmedLine.replace('DECISION:', '').trim()
      if (
        decisionValue === 'INLINE_SUGGESTIONS' ||
        decisionValue === 'PULL_REQUEST'
      ) {
        decision = decisionValue
      }
    } else if (trimmedLine.startsWith('REASONING:')) {
      reasoning = trimmedLine.replace('REASONING:', '').trim()
    } else if (
      !trimmedLine.startsWith('COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT')
    ) {
      // If it's not a known prefix, append to reasoning
      if (reasoning) {
        reasoning += ' ' + trimmedLine
      } else if (!trimmedLine) {
        continue
      }
    }
  }

  // Default to PR if no decision was made or decision is unclear
  if (!decision) {
    decision = 'PULL_REQUEST'
    if (!reasoning) {
      reasoning = 'Agent did not specify a decision, defaulting to PR'
    }
  }

  return { decision, reasoning }
}
