import type { Context } from '@deepseek-ai/cordis'
import type {
  AssistantMessageNode, ConversationNode, ConversationPromptSnapshot,
  ConversationViewBuilder, ConversationViewDefinition,
  ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  WorkflowAssistantRequest,
  WorkflowConversationViewNode, WorkflowRequestHeaderState, WorkflowSurfaceRecord,
  WorkflowRequestView, WorkflowSnapshot,
} from './contract.ts'

/* jscpd:ignore-start -- The distributable Workflow plugin owns its replay builder so Trajectory remains optional and version-independent. */

const EMPTY_LIST: readonly never[] = []
type AssistantRequest = WorkflowAssistantRequest
type ToolSchema = ConversationPromptSnapshot['tools'][number]

/** Stable empty target used until a Session has assembled Workflow records. */
export const EMPTY_WORKFLOW_SNAPSHOT: WorkflowSnapshot = {
  eventNodes: EMPTY_LIST,
  eventLocations: new Map(),
  requests: EMPTY_LIST,
  callSchemas: new Map(),
  partial: null,
  runningCalls: EMPTY_LIST,
}

function stepKey(turn: number, step: number): string {
  return `${turn}\u0000${step}`
}

function headerStepKey(header: WorkflowRequestHeaderState): string | undefined {
  const location = header.location
  return location.kind === 'step'
    ? stepKey(location.turn.turn, location.step.step)
    : undefined
}

function headerFor(
  request: AssistantRequest,
  headersByStep: ReadonlyMap<string, WorkflowRequestHeaderState>,
  previous: WorkflowRequestHeaderState | undefined,
): WorkflowRequestHeaderState | undefined {
  return headersByStep.get(stepKey(request.turn, request.step))
    ?? (previous !== undefined && previous.seq < request.startSeq ? previous : undefined)
}

function applyHeader(
  request: AssistantRequest,
  header: WorkflowRequestHeaderState | undefined,
  includeChange: boolean,
): AssistantRequest {
  return header === undefined
    ? request
    : {
      ...request,
      prompt: header.prompt,
      requestConfig: header.prompt.config,
      ...(includeChange && header.change !== undefined ? { promptChange: header.change } : {}),
    }
}

function withRequestConfig(
  node: AssistantMessageNode,
  prompt: ConversationPromptSnapshot | undefined,
): AssistantMessageNode {
  return prompt === undefined ? node : { ...node, requestConfig: prompt.config }
}

function captureSchemas(
  block: ToolCallBlock,
  toolsByName: ReadonlyMap<string, ToolSchema>,
  output: Map<string, ToolSchema>,
): void {
  const name = 'kind' in block ? block.call?.name : block.name
  const schema = name === undefined ? undefined : toolsByName.get(name)
  if (schema !== undefined) output.set(block.callId, schema)
  for (const child of block.subCalls) captureSchemas(child, toolsByName, output)
}

function indexTools(tools: readonly ToolSchema[]): ReadonlyMap<string, ToolSchema> {
  return new Map(tools.map(tool => [tool.name, tool]))
}

function interruptCompactions(
  requests: WorkflowRequestView[],
  boundaries: readonly { seq: number; time: number }[],
): void {
  let nextRequest = 0
  const runningCompactions: number[] = []
  for (const boundary of boundaries) {
    while (nextRequest < requests.length) {
      const request = requests[nextRequest]
      if (request === undefined || request.startSeq >= boundary.seq) break
      if (request.purpose === 'compaction' && request.status === 'running') {
        runningCompactions.push(nextRequest)
      }
      nextRequest++
    }
    let index = runningCompactions.pop()
    while (index !== undefined && requests[index]?.status !== 'running') {
      index = runningCompactions.pop()
    }
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'compaction') continue
    requests[index] = {
      ...request,
      completedAt: boundary.time,
      status: 'error',
      error: 'Compaction was interrupted before completion.',
    }
  }
}

function applyTurnErrors(
  requests: WorkflowRequestView[],
  endings: readonly { turn: number; time: number; error?: string }[],
): void {
  const lastAssistantByTurn = new Map<number, number>()
  for (const [index, request] of requests.entries()) {
    if (request.purpose === 'assistant') lastAssistantByTurn.set(request.turn, index)
  }
  for (const ending of endings) {
    if (ending.error === undefined) continue
    const index = lastAssistantByTurn.get(ending.turn)
    if (index === undefined) continue
    const request = requests[index]
    if (request?.purpose !== 'assistant') continue
    requests[index] = {
      ...request,
      completedAt: request.completedAt ?? ending.time,
      status: 'error',
      error: ending.error,
    }
  }
}

interface SurfaceEntry {
  readonly seq: number
  readonly message: WorkflowSurfaceRecord['message']
}

function applySurfaceRecord(entries: SurfaceEntry[], record: WorkflowSurfaceRecord): void {
  const next = { seq: record.seq, message: record.message }
  const operation = record.operation
  if (operation.kind === 'append') {
    entries.push(next)
    return
  }
  const start = entries.findIndex(entry => entry.seq === operation.start)
  const end = entries.findIndex(entry => entry.seq === operation.end)
  if (start === -1 || end === -1 || start > end) {
    // An initial tail window can contain a replacement whose shadowed range is
    // still outside the loaded prefix. Workflow pages that prefix immediately;
    // until then, retain only the replacement rather than stale visible input.
    entries.splice(0, entries.length, next)
    return
  }
  entries.splice(start, end - start + 1, next)
}

function attachRequestMessages(
  requests: WorkflowRequestView[],
  records: readonly WorkflowSurfaceRecord[],
): void {
  const entries: SurfaceEntry[] = []
  let recordIndex = 0
  for (const [requestIndex, request] of requests.entries()) {
    if (request.purpose !== 'assistant') continue
    const boundary = request.resultSeq ?? request.completedSeq ?? Number.POSITIVE_INFINITY
    while ((records[recordIndex]?.seq ?? Number.POSITIVE_INFINITY) < boundary) {
      applySurfaceRecord(entries, records[recordIndex] as WorkflowSurfaceRecord)
      recordIndex++
    }
    requests[requestIndex] = {
      ...request,
      messages: entries.flatMap(entry => entry.message === null ? [] : [entry.message]),
    }
  }
}

/** Simple keyed adapter retaining the old Workflow snapshot and stage layout. */
export class WorkflowSnapshotBuilder implements ConversationViewBuilder<
  WorkflowConversationViewNode,
  WorkflowSnapshot
> {
  private readonly nodes = new Map<string, WorkflowConversationViewNode>()
  private readonly positions = new Map<string, number>()
  private contributions: WorkflowConversationViewNode[] = []
  readonly empty = EMPTY_WORKFLOW_SNAPSHOT

  replace(input: {
    readonly nodes: readonly WorkflowConversationViewNode[]
  }): WorkflowSnapshot {
    this.nodes.clear()
    for (const node of input.nodes) this.nodes.set(node.key, node)
    this.rebuildContributions()
    return this.snapshot()
  }

  apply(input: {
    readonly upserts: readonly WorkflowConversationViewNode[]
  }): WorkflowSnapshot {
    let structural = false
    for (const node of input.upserts) {
      const previous = this.nodes.get(node.key)
      this.nodes.set(node.key, node)
      if (previous === undefined || previous.anchorSeq !== node.anchorSeq) {
        structural = true
        continue
      }
      const position = this.positions.get(node.key)
      if (position === undefined) structural = true
      else this.contributions[position] = node
    }
    if (structural) this.rebuildContributions()
    return this.snapshot()
  }

  private snapshot(): WorkflowSnapshot {
    const headersByStep = new Map<string, WorkflowRequestHeaderState>()
    for (const contribution of this.contributions) {
      if (contribution.data.kind !== 'request-header') continue
      const key = headerStepKey(contribution.data.header)
      if (key !== undefined) headersByStep.set(key, contribution.data.header)
    }
    const finalized: ConversationNode[] = []
    const eventLocations = new Map<number, WorkflowConversationViewNode['location']>()
    const requests: WorkflowRequestView[] = []
    const boundaries: { seq: number; time: number }[] = []
    const turnEndings: { turn: number; time: number; error?: string }[] = []
    const callSchemas = new Map<string, ToolSchema>()
    const surfaceRecords: WorkflowSurfaceRecord[] = []
    const consumedPromptChanges = new Set<number>()
    let previousHeader: WorkflowRequestHeaderState | undefined
    let previousTools: ReadonlyMap<string, ToolSchema> = new Map()
    let partial: WorkflowSnapshot['partial'] = null
    const runningCalls: WorkflowSnapshot['runningCalls'][number][] = []

    for (const contribution of this.contributions) {
      const data = contribution.data
      if (data.kind === 'request-header') {
        previousHeader = data.header
        previousTools = indexTools(data.header.prompt.tools)
        continue
      }
      if (data.kind === 'surface') {
        surfaceRecords.push(data.record)
        continue
      }
      if (data.kind === 'node') {
        finalized.push(data.node)
        eventLocations.set(data.node.seq, contribution.location)
        continue
      }
      if (data.kind === 'assistant') {
        const header = data.request === undefined
          ? undefined
          : headerFor(data.request, headersByStep, previousHeader)
        if (data.node !== undefined) finalized.push(withRequestConfig(data.node, header?.prompt))
        if (data.partial !== null) partial = data.partial
        if (data.request !== undefined) {
          const includeChange = header?.change !== undefined
            && !consumedPromptChanges.has(header.seq)
          requests.push(applyHeader(data.request, header, includeChange))
          if (includeChange) consumedPromptChanges.add(header.seq)
        }
        continue
      }
      if (data.kind === 'tool') {
        if ('kind' in data.root) finalized.push(data.root)
        else runningCalls.push(data.root)
        if (previousHeader !== undefined && previousHeader.seq < contribution.anchorSeq) {
          captureSchemas(data.root, previousTools, callSchemas)
        }
        continue
      }
      if (data.kind === 'compaction') {
        requests.push(data.request)
        continue
      }
      if (data.kind === 'session-end') {
        boundaries.push({ seq: data.seq, time: data.time })
        continue
      }
      turnEndings.push({
        turn: data.turn,
        time: data.time,
        ...(data.error === undefined ? {} : { error: data.error }),
      })
    }

    requests.sort((left, right) => left.startSeq - right.startSeq)
    interruptCompactions(requests, boundaries)
    applyTurnErrors(requests, turnEndings)
    attachRequestMessages(requests, surfaceRecords)
    finalized.sort((left, right) => left.seq - right.seq)
    const eventNodes = finalized
    return {
      eventNodes,
      eventLocations,
      requests,
      callSchemas,
      partial,
      runningCalls,
    }
  }

  private rebuildContributions(): void {
    this.contributions = [...this.nodes.values()]
      .sort((left, right) => left.anchorSeq - right.anchorSeq || left.key.localeCompare(right.key))
    this.positions.clear()
    for (const [index, contribution] of this.contributions.entries()) {
      this.positions.set(contribution.key, index)
    }
  }
}

/** Workflow target factory preserving the existing stage-oriented view model. */
export const workflowViewDefinition: ConversationViewDefinition<
  WorkflowConversationViewNode,
  WorkflowSnapshot
> = {
  target: 'workflow',
  create: () => new WorkflowSnapshotBuilder(),
}

/**
 * Register the stage-oriented Workflow target builder.
 *
 * @param ctx - Plugin context receiving the view Definition.
 */
export function registerWorkflowConversationView(ctx: Context): void {
  ctx.uiConversation.views.register(workflowViewDefinition)
}
/* jscpd:ignore-end */
