/**
 * The parsed output from the agent's completion signal
 */
export interface AgentCompletionOutput {
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
  episode_id?: string
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

  let reasoning = ''

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (trimmedLine.startsWith('REASONING:')) {
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

  if (!reasoning) {
    reasoning = 'Agent completed task without providing reasoning'
  }

  return { reasoning }
}
