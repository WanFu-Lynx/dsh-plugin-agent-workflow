import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationNodeDefinition, ConversationPreviousContext,
  SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  contextForm, contextProducer,
} from './event-projection.ts'
import type {} from '@deepseek-ai/dsh-agent/types'
import { workflowNode } from './definition-common.ts'

/* jscpd:ignore-start -- Workflow owns an independent event state machine so
 * replay cannot modify or short-circuit Chat and Trajectory projections. */
interface InboxIdentity {
  readonly id: string
}

interface InboxSplice {
  readonly start: number
  readonly removedCount?: number
  readonly inserted: readonly InboxIdentity[]
  readonly outcome?: 'canceled'
}

interface InboxState {
  readonly pending: readonly InboxIdentity[]
  readonly claimed: ReadonlySet<string>
}

type MessageNode = UserMessageNode | SteeringMessageNode | ContextMessageNode

function applySplice(
  previous: ConversationPreviousContext<InboxState> | undefined,
  splice: InboxSplice,
): InboxState {
  const pending = [...(previous?.state.pending ?? [])]
  const claimed = new Set(previous?.state.claimed ?? [])
  const removed = pending.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  for (const identity of splice.inserted) claimed.delete(identity.id)
  if (splice.outcome !== 'canceled') {
    for (const identity of removed) claimed.add(identity.id)
  }
  return { pending, claimed }
}

const workflowInboxDefinition: ConversationNodeDefinition<InboxState> = {
  kind: 'workflow-inbox-next-step',
  match: event => event.type === 'agent/inbox/spliced'
    && event.data.target === 'next-step'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'agent/inbox/spliced') {
      throw new Error('workflow-inbox-next-step start requires agent/inbox/spliced')
    }
    return applySplice(
      reader.previous<InboxState>('workflow-inbox-next-step'),
      match.event.data,
    )
  },
  update: context => context.state,
  publication: () => 'none',
}

const workflowMessageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'workflow-input-message',
  target: 'workflow',
  match: event => event.type === 'user/message'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'user/message') {
      throw new Error('workflow-input-message start requires user/message')
    }
    const event = match.event
    if (event.data.source.kind !== 'user') {
      return {
        kind: 'context',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        producer: contextProducer(event.data.source),
        form: contextForm(event.data.source),
      }
    }
    const claimed = reader.previous<InboxState>('workflow-inbox-next-step')
      ?.state.claimed.has(String(event.data.id)) === true
    return claimed
      ? {
        kind: 'steering',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
      : {
        kind: 'user',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : workflowNode(context, context.state.seq, { kind: 'node', node: context.state }),
}
/* jscpd:ignore-end */

/**
 * Register Workflow-owned inbox classification and message records.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerWorkflowMessageDefinitions(ctx: Context): void {
  ctx.uiConversation.events.register(workflowInboxDefinition)
  ctx.uiConversation.events.register(workflowMessageDefinition)
}
