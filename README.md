# GitHub Action for TensorZero-powered CI fixes and feedback

[![GitHub Super-Linter](https://github.com/actions/typescript-action/actions/workflows/linter.yml/badge.svg)](https://github.com/super-linter/super-linter)
![CI](https://github.com/actions/typescript-action/actions/workflows/ci.yml/badge.svg)
[![Check dist/](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/check-dist.yml)
[![CodeQL](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml/badge.svg)](https://github.com/actions/typescript-action/actions/workflows/codeql-analysis.yml)
[![Coverage](./badges/coverage.svg)](./badges/coverage.svg)

## Running Locally

You can run the mini-swe-agent locally to test PRs before deploying to GitHub
Actions.

### Prerequisites

1. Install dependencies:

   ```bash
   npm install
   npm run bundle  # Build the CLI
   ```

1. Set up required environment variables:

   ```bash
   # GitHub authentication (choose one):
   export GITHUB_TOKEN=$(gh auth token)  # If using gh CLI
   # OR
   export GITHUB_TOKEN=ghp_your_token_here

   # Model API keys (at least one required):
   export ANTHROPIC_API_KEY=your_anthropic_key
   # OR
   export OPENAI_API_KEY=your_openai_key
   ```

### Usage

#### Dry Run (Local Testing)

Test the agent without creating PRs or comments on GitHub:

```bash
npm run cli -- --repo owner/repo --pr 123 --dry-run
```

This will:

- Clone the PR repository
- Run the mini-swe-agent to analyze and fix issues
- Display the generated patch locally
- Not make any changes to GitHub

#### Live Mode (Create PRs/Comments)

Run the agent and create actual PRs or inline comments on GitHub:

```bash
npm run cli -- --repo owner/repo --pr 456
```

This will:

- Clone the PR repository
- Run the mini-swe-agent
- Create a follow-up PR or post inline comments based on the agent's decision

#### With CI Failure Context

If you have a specific workflow run that failed, you can provide its ID:

```bash
npm run cli -- --repo owner/repo --pr 789 --workflow-run-id 12345
```

### CLI Options

```text
-r, --repo <owner/repo>          Repository in "owner/repo" format
-p, --pr <number>                Pull request number (required)
-d, --dry-run                    Show patch locally without PRs/comments
-t, --token <token>              GitHub token (default: GITHUB_TOKEN or gh)
-w, --workflow-run-id <id>       Workflow run ID for failure logs
-o, --output-dir <path>          Directory for debug artifacts
--clickhouse-url <url>           ClickHouse URL for tracking
--clickhouse-table <name>        ClickHouse table name
-c, --cost-limit <dollars>       Cost limit (default: 3.0)
--timeout <minutes>              Timeout in minutes (default: 30)
-h, --help                       Show help message
```

### Examples

```bash
# Dry run on a public repository
npm run cli -- --repo tensorzero/tensorzero --pr 100 --dry-run

# Run on your own repository with custom settings
export GITHUB_TOKEN=$(gh auth token)
npm run cli -- \
  --repo myorg/myrepo \
  --pr 42 \
  --cost-limit 5.0 \
  --timeout 45 \
  --output-dir ./debug-output

# Analyze a specific failed workflow run
npm run cli -- \
  --repo owner/repo \
  --pr 123 \
  --workflow-run-id 9876543210
```

## Developing

- `npm install`
- `npm run bundle` will build the action for distribution.

## Deploying

- `npm run bundle` will build the action.
- Prepare a ClickHouse Cloud database
  - We need to add a table for Inference => PR association; assuming one
    inference per PR. Might be able to iterate.
  - Configure the action inputs `clickhouse-url`, `clickhouse-table`, and
    optional authentication parameters so the action can write inference to PR
    mappings after creating follow-up pull requests.
- Configure secrets for the repository:
  - CI_BOT_OPENAI_API_KEY: OpenAI API key, used when starting TensorZero gateway
  - CI_BOT_CLICKHOUSE_URL: ClickHouse URL for both TensorZero gateway and the
    GitHub PR to inference mapping; expected format is
    `http[s]://[username:password@]hostname:port[/database]`.
- Configure GitHub Actions permissions for the repository:
  - Under "Settings > Actions > General", check the box for "Allow GitHub
    Actions to create and approve pull requests".

### Prepare ClickHouse database

We need to create a new table to store GitHub PR to Inference Map:

```sql
CREATE TABLE GitHubBotPullRequestToInferenceMap
(
   pull_request_id UInt128,
   inference_id String,
   episode_id String,
   created_at DateTime DEFAULT now(),
   original_pull_request_url String
)
ENGINE = ReplacingMergeTree
ORDER BY pull_request_id;
```

## When might this fail over?

- Long context / large PRs

## Publishing a New Release

This project includes a helper script, [`script/release`](./script/release)
designed to streamline the process of tagging and pushing new releases for
GitHub Actions.

GitHub Actions allows users to select a specific version of the action to use,
based on release tags. This script simplifies this process by performing the
following steps:

1. **Retrieving the latest release tag:** The script starts by fetching the most
   recent SemVer release tag of the current branch, by looking at the local data
   available in your repository.
1. **Prompting for a new release tag:** The user is then prompted to enter a new
   release tag. To assist with this, the script displays the tag retrieved in
   the previous step, and validates the format of the inputted tag (vX.X.X). The
   user is also reminded to update the version field in package.json.
1. **Tagging the new release:** The script then tags a new release and syncs the
   separate major tag (e.g. v1, v2) with the new release tag (e.g. v1.0.0,
   v2.1.2). When the user is creating a new major release, the script
   auto-detects this and creates a `releases/v#` branch for the previous major
   version.
1. **Pushing changes to remote:** Finally, the script pushes the necessary
   commits, tags and branches to the remote repository. From here, you will need
   to create a new release in GitHub so users can easily reference the new tags
   in their workflows.

## Dependency License Management

This template includes a GitHub Actions workflow,
[`licensed.yml`](./.github/workflows/licensed.yml), that uses
[Licensed](https://github.com/licensee/licensed) to check for dependencies with
missing or non-compliant licenses. This workflow is initially disabled. To
enable the workflow, follow the below steps.

1. Open [`licensed.yml`](./.github/workflows/licensed.yml)
1. Uncomment the following lines:

   ```yaml
   # pull_request:
   #   branches:
   #     - main
   # push:
   #   branches:
   #     - main
   ```

1. Save and commit the changes

Once complete, this workflow will run any time a pull request is created or
changes pushed directly to `main`. If the workflow detects any dependencies with
missing or non-compliant licenses, it will fail the workflow and provide details
on the issue(s) found.

### Updating Licenses

Whenever you install or update dependencies, you can use the Licensed CLI to
update the licenses database. To install Licensed, see the project's
[Readme](https://github.com/licensee/licensed?tab=readme-ov-file#installation).

To update the cached licenses, run the following command:

```bash
licensed cache
```

To check the status of cached licenses, run the following command:

```bash
licensed status
```
