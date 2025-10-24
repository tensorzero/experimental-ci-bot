import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  type AgentTrajectory,
  type AgentCompletionOutput,
  parseAgentCompletion
} from './types/agentOutput.js'

export interface MiniSweAgentConfig {
  /**
   * The task for the agent to complete
   */
  task: string

  /**
   * Working directory for the agent (where the repo is cloned)
   */
  cwd: string

  /**
   * Path to the TensorZero config directory (containing tensorzero.toml and templates/)
   */
  tensorZeroConfigPath: string

  /**
   * Optional output path for the trajectory file
   */
  trajectoryOutputPath?: string

  /**
   * Cost limit for the agent in dollars (default: 3.0)
   */
  costLimit?: number

  /**
   * Step limit for the agent (default: 0 = unlimited)
   */
  stepLimit?: number

  /**
   * Model name to use (default: uses TensorZero config)
   */
  modelName?: string

  /**
   * Timeout in milliseconds (default: 30 minutes)
   */
  timeout?: number

  /**
   * Pull request number for tagging
   */
  prNumber?: number
}

export interface MiniSweAgentResult {
  /**
   * The agent's decision and reasoning
   */
  completion: AgentCompletionOutput

  /**
   * Full trajectory of the agent's execution
   */
  trajectory: AgentTrajectory

  /**
   * Standard output from the agent
   */
  stdout: string

  /**
   * Standard error from the agent
   */
  stderr: string

  /**
   * Exit code from the agent process
   */
  exitCode: number | null
}

/**
 * Run the mini-swe-agent with the given configuration
 */
export async function runMiniSweAgent(
  config: MiniSweAgentConfig
): Promise<MiniSweAgentResult> {
  const {
    task,
    cwd,
    tensorZeroConfigPath,
    // trajectoryOutputPath is ignored - we always use temp file now
    costLimit = 3.0,
    stepLimit = 0,
    modelName,
    timeout = 30 * 60 * 1000, // 30 minutes
    prNumber
  } = config

  // Create a temporary trajectory file that we'll delete after reading
  const tempTrajectoryPath = path.join(
    os.tmpdir(),
    `agent_trajectory_${Date.now()}_${Math.random().toString(36).substring(7)}.json`
  )

  // Build command arguments
  const args = [
    '-t',
    task,
    '-o',
    tempTrajectoryPath,
    '-l',
    costLimit.toString(),
    '--exit-immediately',
    '-y' // YOLO mode - don't ask for confirmation
  ]

  if (stepLimit > 0) {
    // mini-swe-agent doesn't have a step-limit CLI flag, but we can set it in config
    // For now, we'll skip this and rely on cost limit
  }

  if (modelName) {
    args.push('-m', modelName)
  }

  if (prNumber !== undefined) {
    args.push('--tag', `pr_number=${prNumber}`)
  }

  // Set up environment variables
  const env = {
    ...process.env,
    TENSORZERO_CONFIG_PATH: tensorZeroConfigPath,
    // Ensure Python output is unbuffered for better logging
    PYTHONUNBUFFERED: '1'
  }

  console.log(`Running mini-swe-agent with task: ${task}`)
  console.log(`Working directory: ${cwd}`)
  console.log(`TensorZero config: ${tensorZeroConfigPath}`)

  return new Promise((resolve, reject) => {
    const proc = spawn(
      'uv',
      ['run', '--project', process.cwd(), 'mini', ...args],
      {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )

    let stdout = ''
    let stderr = ''

    proc.stdout?.on('data', (data) => {
      const chunk = data.toString()
      stdout += chunk
      console.log(`[mini-swe-agent] ${chunk}`)
    })

    proc.stderr?.on('data', (data) => {
      const chunk = data.toString()
      stderr += chunk
      console.error(`[mini-swe-agent] ${chunk}`)
    })

    // Set up timeout
    const timeoutId = setTimeout(() => {
      proc.kill('SIGTERM')
      reject(
        new Error(`mini-swe-agent timed out after ${timeout / 1000} seconds`)
      )
    }, timeout)

    proc.on('close', (code) => {
      clearTimeout(timeoutId)

      console.log(`mini-swe-agent exited with code ${code}`)

      // Read the trajectory file from temp location
      let trajectory: AgentTrajectory
      try {
        const trajectoryContent = fs.readFileSync(tempTrajectoryPath, 'utf-8')
        trajectory = JSON.parse(trajectoryContent)
      } catch (error) {
        reject(
          new Error(
            `Failed to read trajectory file: ${error instanceof Error ? error.message : String(error)}`
          )
        )
        return
      } finally {
        // Delete the temporary trajectory file
        try {
          if (fs.existsSync(tempTrajectoryPath)) {
            fs.unlinkSync(tempTrajectoryPath)
            console.log('Deleted temporary trajectory file')
          }
        } catch (error) {
          console.warn(
            `Failed to delete temporary trajectory file: ${error instanceof Error ? error.message : String(error)}`
          )
        }
      }

      // Parse the completion output from the trajectory
      const completion = parseAgentCompletion(trajectory.info.submission)

      resolve({
        completion,
        trajectory,
        stdout,
        stderr,
        exitCode: code
      })
    })

    proc.on('error', (error) => {
      clearTimeout(timeoutId)
      reject(
        new Error(
          `Failed to spawn mini-swe-agent: ${error instanceof Error ? error.message : String(error)}`
        )
      )
    })
  })
}
