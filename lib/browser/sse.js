/**
 * SSE chunk-stream assembly for both dsh-llm-trace browser faces.
 *
 * A provider streams one chunk per token and repeats the whole JSON envelope on
 * every one, so a captured response is about 98% envelope by bytes. This keeps
 * only the deltas and the usage block, which is what makes the assembled view of
 * a multi-hundred-kilobyte stream a few kilobytes of reading.
 *
 * The viewer document and the Conversation View bundle both `import()` this
 * module, so the two faces cannot drift apart.
 *
 * @module dsh-llm-trace/sse
 */

/** Text of the `data:` field that closes an OpenAI-style stream. */
const DONE = '[DONE]'

/**
 * Rebuild one readable view from an OpenAI-style SSE chunk stream.
 *
 * Reasoning and content deltas concatenate; tool-call fragments reassemble by
 * their stream index, because a provider splits one call's arguments across many
 * chunks. A body cut at the capture limit leaves a final partial line, which is
 * counted in `broken` rather than thrown.
 *
 * @param raw - the captured response body.
 * @returns the assembled sections and their counts.
 */
export function assembleSse(raw) {
  const acc = { reasoning: '', content: '', tools: [], finish: null, usage: null, chunks: 0, done: false, broken: 0 }
  const lines = raw.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (line.slice(0, 6) !== 'data: ') continue
    const payload = line.slice(6).trim()
    if (payload === DONE) {
      acc.done = true
      continue
    }
    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch (error) {
      acc.broken++
      continue
    }
    acc.chunks++
    if (chunk.usage) acc.usage = chunk.usage
    const choices = chunk.choices || []
    for (let i = 0; i < choices.length; i++) {
      const choice = choices[i]
      const delta = choice.delta || {}
      if (delta.reasoning_content) acc.reasoning += delta.reasoning_content
      if (delta.content) acc.content += delta.content
      const calls = delta.tool_calls || []
      for (let k = 0; k < calls.length; k++) {
        const call = calls[k]
        const at = call.index === undefined ? 0 : call.index
        if (!acc.tools[at]) acc.tools[at] = { id: '', name: '', args: '' }
        if (call.id) acc.tools[at].id = call.id
        if (call.function) {
          if (call.function.name) acc.tools[at].name += call.function.name
          if (call.function.arguments) acc.tools[at].args += call.function.arguments
        }
      }
      if (choice.finish_reason) acc.finish = choice.finish_reason
    }
  }
  return acc
}

/** Whether a captured body is an SSE stream this module can assemble. */
export function isSseBody(mimeType) {
  return (mimeType || '').indexOf('event-stream') >= 0
}
