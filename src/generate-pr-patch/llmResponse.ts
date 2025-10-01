export function extractXmlTagFromLlmResponse(
  response: string,
  tag: string
): string[] {
  const regex = new RegExp(`<${tag}>(.*?)<\\/${tag}>`, 'sg')
  const matches = response.matchAll(regex)

  // Take the first capture group from each match
  const outputs = [...matches].map((match) => match[1].trim())
  return outputs || []
}
