import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { WorkflowRequestView } from './contract.ts'
import { workflowNode } from './definition-common.ts'

/* jscpd:ignore-start -- The distributable Workflow plugin owns its target state machine and cannot import Trajectory's private Definition. */

interface CompactionState {
  readonly start: ConversationMatch
  readonly summary?: ConversationMatch
  readonly end?: ConversationMatch
  readonly checkpoint?: ConversationMatch
}

function checkpointId(
  event: Parameters<ConversationNodeDefinition['match']>[0],
): string | undefined {
  if (event.type !== 'user/message') return undefined
  const source = event.data.source as unknown as {
    readonly kind?: unknown
    readonly plugin?: unknown
    readonly compactionId?: unknown
  }
  return source.kind === 'plugin' && source.plugin === 'compact'
    && typeof source.compactionId === 'string' && source.compactionId !== ''
    ? source.compactionId
    : undefined
}

function eventCompactionId(
  event: Parameters<ConversationNodeDefinition['match']>[0],
): string | undefined {
  if (event.type !== 'compaction/start'
    && event.type !== 'compaction/summary'
    && event.type !== 'compaction/end') return undefined
  const value: unknown = event.data.compactionId
  return typeof value === 'string' && value !== '' ? value : undefined
}

function requestFromState(
  state: CompactionState,
): Extract<WorkflowRequestView, { purpose: 'compaction' }> | undefined {
  const start = state.start.event
  if (start.type !== 'compaction/start') return undefined
  const summary = state.summary?.event
  const end = state.end?.event
  const checkpoint = state.checkpoint?.event
  return {
    purpose: 'compaction',
    startSeq: start.seq,
    turn: start.data.turn,
    step: 0,
    startedAt: start.time,
    completedAt: end?.type === 'compaction/end' ? end.time : null,
    status: end?.type !== 'compaction/end'
      ? 'running'
      : end.data.error === undefined ? 'complete' : 'error',
    ...(end?.type === 'compaction/end' && end.data.error !== undefined
      ? { error: end.data.error }
      : {}),
    ...(summary?.type !== 'compaction/summary'
      ? {}
      : {
        resultSeq: summary.seq,
        summary: summary.data.summary,
        ...(summary.data.rawOutput === undefined ? {} : { rawOutput: summary.data.rawOutput }),
        provenance: { provider: summary.data.provider, model: summary.data.model },
        requestConfig: {
          provider: summary.data.provider,
          model: summary.data.model,
          purpose: 'compaction',
          ...(summary.data.maxTokens === undefined ? {} : { maxTokens: summary.data.maxTokens }),
        },
        ...(summary.data.usage === undefined ? {} : { usage: summary.data.usage }),
      }),
    ...(checkpoint?.type === 'user/message' ? { replacementSeq: checkpoint.seq } : {}),
  }
}

const workflowCompactionDefinition: ConversationNodeDefinition<CompactionState> = {
  kind: 'workflow-compaction',
  target: 'workflow',
  match: (event) => {
    const compactId = eventCompactionId(event)
    if (compactId !== undefined) {
      return { id: compactId, role: event.type === 'compaction/start' ? 'start' : 'update' }
    }
    const checkpoint = checkpointId(event)
    return checkpoint === undefined ? null : { id: checkpoint, role: 'update' }
  },
  start: (_context, match) => {
    if (match.event.type !== 'compaction/start') {
      throw new Error('workflow-compaction start requires compaction/start')
    }
    return { start: match }
  },
  update: (context, match) => {
    if (match.event.type === 'compaction/summary') return { ...context.state, summary: match }
    if (match.event.type === 'compaction/end') return { ...context.state, end: match }
    return checkpointId(match.event) === undefined
      ? context.state
      : { ...context.state, checkpoint: match }
  },
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const request = requestFromState(context.state)
    return request === undefined
      ? null
      : workflowNode(context, request.startSeq, { kind: 'compaction', request })
  },
}

interface SessionEndState {
  readonly seq: number
  readonly time: number
}

const workflowSessionEndDefinition: ConversationNodeDefinition<SessionEndState> = {
  kind: 'workflow-session-end',
  target: 'workflow',
  match: event => event.type === 'session/end-seed'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => ({ seq: match.event.seq, time: match.event.time }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : workflowNode(context, context.state.seq, {
      kind: 'session-end',
      seq: context.state.seq,
      time: context.state.time,
    }),
}

/**
 * Register Workflow compaction requests and session boundaries.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerWorkflowCompactionDefinitions(ctx: Context): void {
  ctx.uiConversation.events.register(workflowCompactionDefinition)
  ctx.uiConversation.events.register(workflowSessionEndDefinition)
}
/* jscpd:ignore-end */
