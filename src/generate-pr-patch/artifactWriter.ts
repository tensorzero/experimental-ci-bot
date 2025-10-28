import * as core from '@actions/core'
import * as fs from 'fs'
import * as path from 'path'

import {
  PATCH_MANIFEST_SCHEMA_VERSION,
  type PullRequestPatchManifest
} from '../artifacts/pullRequestPatchManifest.js'

function ensureDirectoryExists(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function writeTextFile(baseDir: string, relativePath: string, content: string) {
  const absolutePath = path.join(baseDir, relativePath)
  ensureDirectoryExists(path.dirname(absolutePath))
  fs.writeFileSync(absolutePath, content, { encoding: 'utf-8' })
  core.info(`Wrote ${relativePath} artifact to ${absolutePath}`)
}

function writeJsonFile(
  baseDir: string,
  relativePath: string,
  content: unknown
) {
  writeTextFile(baseDir, relativePath, JSON.stringify(content, null, 2))
}

export interface WritePatchArtifactsOptions {
  outputDir: string | undefined
  manifest: PullRequestPatchManifest
  diff?: string
  generatedCommentBody?: string
  commands?: string[]
}

export function writePatchArtifacts(options: WritePatchArtifactsOptions): void {
  const { outputDir, manifest, diff, generatedCommentBody, commands } = options

  if (!outputDir) {
    core.warning(
      'Output artifact directory not provided; skipping patch artifact creation.'
    )
    return
  }

  ensureDirectoryExists(outputDir)

  if (diff) {
    const patchPath =
      manifest.outputs.generatedPatchPath ?? 'generated-patch.diff'
    manifest.outputs.generatedPatchPath = patchPath
    writeTextFile(
      outputDir,
      patchPath,
      diff.endsWith('\n') ? diff : `${diff}\n`
    )
  }

  if (generatedCommentBody) {
    const commentPath =
      manifest.outputs.generatedCommentPath ?? 'generated-comment.md'
    manifest.outputs.generatedCommentPath = commentPath
    writeTextFile(outputDir, commentPath, generatedCommentBody)
  }

  if (commands && commands.length > 0) {
    const commandsPath = manifest.outputs.commandsPath ?? 'commands.json'
    manifest.outputs.commandsPath = commandsPath
    writeJsonFile(outputDir, commandsPath, commands)
  }

  const manifestPath = path.join(outputDir, 'manifest.json')
  writeJsonFile(outputDir, 'manifest.json', {
    ...manifest,
    schemaVersion: PATCH_MANIFEST_SCHEMA_VERSION
  })
  core.info(`Patch manifest written to ${manifestPath}`)
}
