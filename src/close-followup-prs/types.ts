export interface CloseFollowupPrsActionInput {
  githubToken: string
}

export interface FollowupPrInfo {
  number: number
  id: number
  htmlUrl: string
  headRef: string
}

export interface CloseFollowupPrsResult {
  closed: number
  errors: string[]
}
