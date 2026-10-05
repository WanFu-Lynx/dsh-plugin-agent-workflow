/** Workflow-owned conversion from durable Session events to ledger view data.
 *
 * DeepSeek Harness 0.1.2-rc.1 consolidated these helpers into private
 * `trajectory-event-projection` / `chat` internals that are not legal package
 * subpath exports. The Workflow projection duplicates the stateless subset it
 * needs so it never value-imports another client plugin's private module.
 */
import type { ContentBlock, StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type {
  AssistantBlock, ContextProducerView, KnownContextForm,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function collect(source: Record<string, unknown>, member: string, field: string): string[] {
  const list = source[member]
  if (!Array.isArray(list)) return []
  const seen: string[] = []
  for (const entry of list) {
    const record = asRecord(entry)
    const value = record === null ? null : readString(record, field)
    if (value !== null && !seen.includes(value)) seen.push(value)
  }
  return seen
}

function joined(names: string[]): string | null {
  return names.length > 0 ? names.join(', ') : null
}

/** Forms Workflow presents structurally; unknown merge-extensible values remain opaque. */
const KNOWN_FORMS: readonly string[] = [
  'instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall',
]

/** Read the target-supported presentation form from a durable message source. */
export function contextForm(source: unknown): KnownContextForm | null {
  const record = asRecord(source)
  const form = record === null ? null : readString(record, 'form')
  return form !== null && KNOWN_FORMS.includes(form) ? form as KnownContextForm : null
}

/** Project a durable message source to the row's role and producer label. */
export function contextProducer(source: unknown): ContextProducerView {
  const record = asRecord(source)
  const kind = record === null ? null : readString(record, 'kind')
  if (record === null || kind === null) return { role: 'inject', label: null }
  switch (kind) {
    case 'session-reference': return { role: 'recall', label: joined(collect(record, 'references', 'label')) ?? kind }
    case 'agent-instructions': return { role: 'inject', label: joined(collect(record, 'changes', 'path')) ?? kind }
    case 'plugin': return { role: 'inject', label: readString(record, 'plugin') ?? kind }
    case 'skill-invocation': return { role: 'inject', label: readString(record, 'name') ?? kind }
    default: return { role: 'inject', label: kind }
  }
}

/** Classify finalized Assistant content for Workflow rendering. */
export function toAssistantBlocks(content: readonly ContentBlock[]): AssistantBlock[] {
  return content.map(toAssistantBlock)
}

/** Classify one finalized Assistant block for Workflow rendering. */
export function toAssistantBlock(block: ContentBlock): AssistantBlock {
  switch (block.type) {
    case 'text': return { kind: 'text', text: block.text }
    case 'reasoning': return { kind: 'reasoning', text: block.text }
    case 'image': return { kind: 'image', attachment: block.attachment }
    case 'tool-call': return { kind: 'tool-call', callId: String(block.id), name: block.name, argsRaw: block.arguments }
    default: return { kind: 'other', block: block as unknown }
  }
}

/** Create the initial Workflow block for one streamed Assistant block kind. */
export function emptyAssistantBlock(blockType: string): AssistantBlock {
  switch (blockType) {
    case 'text': return { kind: 'text', text: '' }
    case 'reasoning': return { kind: 'reasoning', text: '' }
    case 'tool-call': return { kind: 'tool-call', callId: '', name: '', argsRaw: '' }
    default: return { kind: 'other', block: null as unknown }
  }
}

/** Display-safe failure fields retained by Workflow projections. */
export interface DisplayFailure {
  readonly code?: string
  readonly message: string
}

/** Convert a durable failure to locale-independent fields safe for Workflow. */
export function displayFailure(failure: unknown): DisplayFailure {
  if (failure === null || typeof failure !== 'object') return { message: String(failure) }
  const record = failure as Record<string, unknown>
  const code = typeof record.code === 'string' ? record.code : undefined
  if (code === 'AUTH') return { code, message: '' }
  return {
    ...(code === undefined ? {} : { code }),
    message: typeof record.message === 'string' ? record.message : JSON.stringify(failure),
  }
}

/** Whether a stream chunk carries visible model output for Workflow timing. */
export function isTokenDelta(chunk: StreamChunk): boolean {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta': return chunk.text !== ''
    case 'tool-call-delta': return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default: return false
  }
}