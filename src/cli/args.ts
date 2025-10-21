/**
 * CLI argument parsing and validation for local execution
 */

export interface CliOptions {
  /**
   * Repository in the format "owner/repo"
   */
  repository: string

  /**
   * Pull request number
   */
  pr: number

  /**
   * Dry run mode - show patch locally without creating PRs/comments
   */
  dryRun: boolean

  /**
   * Optional GitHub token (if not provided, will try to use gh CLI)
   */
  token?: string

  /**
   * Optional workflow run ID to fetch failure logs from
   */
  workflowRunId?: number

  /**
   * Output directory for debug artifacts
   */
  outputDir?: string

  /**
   * Optional ClickHouse URL for tracking
   */
  clickhouseUrl?: string

  /**
   * Optional ClickHouse table name
   */
  clickhouseTable?: string

  /**
   * Cost limit for mini-swe-agent in dollars
   */
  costLimit?: number

  /**
   * Timeout in minutes
   */
  timeout?: number

  /**
   * Test mode - add comments to files without running agent
   */
  testMode?: boolean
}

/**
 * Parse command-line arguments
 */
export function parseArgs(args: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    dryRun: false,
    costLimit: 3.0,
    timeout: 30,
    testMode: false
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--repo':
      case '-r':
        options.repository = args[++i]
        break

      case '--pr':
      case '-p':
        options.pr = parseInt(args[++i], 10)
        break

      case '--dry-run':
      case '-d':
        options.dryRun = true
        break

      case '--test-mode':
        options.testMode = true
        break

      case '--token':
      case '-t':
        options.token = args[++i]
        break

      case '--workflow-run-id':
      case '-w':
        options.workflowRunId = parseInt(args[++i], 10)
        break

      case '--output-dir':
      case '-o':
        options.outputDir = args[++i]
        break

      case '--clickhouse-url':
        options.clickhouseUrl = args[++i]
        break

      case '--clickhouse-table':
        options.clickhouseTable = args[++i]
        break

      case '--cost-limit':
      case '-c':
        options.costLimit = parseFloat(args[++i])
        break

      case '--timeout':
        options.timeout = parseInt(args[++i], 10)
        break

      case '--help':
      case '-h':
        printHelp()
        process.exit(0)

      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`)
          printHelp()
          process.exit(1)
        }
    }
  }

  // Validate required options
  if (!options.repository) {
    console.error('Error: --repo is required')
    printHelp()
    process.exit(1)
  }

  if (!options.pr) {
    console.error('Error: --pr is required')
    printHelp()
    process.exit(1)
  }

  // Validate repository format
  if (!options.repository.match(/^[\w-]+\/[\w-]+$/)) {
    console.error(
      `Error: Invalid repository format "${options.repository}". Expected format: owner/repo`
    )
    process.exit(1)
  }

  return options as CliOptions
}

function printHelp(): void {
  console.log(`
Usage: experimental-ci-bot [options]

Options:
  -r, --repo <owner/repo>          Repository in format "owner/repo" (required)
  -p, --pr <number>                Pull request number (required)
  -d, --dry-run                    Show patch locally without creating PRs/comments
  --test-mode                      Test mode: add comments without running agent (for integration testing)
  -t, --token <token>              GitHub token (default: uses GITHUB_TOKEN env or gh CLI)
  -w, --workflow-run-id <id>       Workflow run ID (default: auto-detects latest failed run)
  -o, --output-dir <path>          Directory for debug artifacts
  --clickhouse-url <url>           ClickHouse URL for tracking
  --clickhouse-table <name>        ClickHouse table name
  -c, --cost-limit <dollars>       Cost limit for mini-swe-agent (default: 3.0)
  --timeout <minutes>              Timeout in minutes (default: 30)
  -h, --help                       Show this help message

Environment Variables:
  GITHUB_TOKEN                     GitHub personal access token
  ANTHROPIC_API_KEY                Anthropic API key (required for mini-swe-agent)
  OPENAI_API_KEY                   OpenAI API key (alternative to Anthropic)

Examples:
  # Dry run - automatically finds latest failed workflow run
  experimental-ci-bot --repo tensorzero/tensorzero --pr 123 --dry-run

  # Create actual PR/comments (requires write access)
  export GITHUB_TOKEN=\$(gh auth token)
  experimental-ci-bot --repo myorg/myrepo --pr 456

  # Fix a specific workflow run
  experimental-ci-bot --repo owner/repo --pr 789 --workflow-run-id 12345
`)
}
