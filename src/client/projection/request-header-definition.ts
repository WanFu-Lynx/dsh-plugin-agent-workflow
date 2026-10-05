import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, RequestPromptInspector,
  SystemPromptInspector, SystemPromptState,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { workflowNode } from './definition-common.ts'
import type { WorkflowRequestHeaderState } from './contract.ts'

/* jscpd:ignore-start -- The distributable Workflow plugin owns its target Definition and cannot import Trajectory's private Definition. */

/** System-prompt surface tracking retained until the next request header. */
function workflowSystemMessageDefinition(
  inspect: SystemPromptInspector,
): ConversationNodeDefinition<SystemPromptState> {
  return {
    kind: 'workflow-system-message',
    match: event =>
      event.type === 'system/message' || ('surfaceOp' in event && event.surfaceOp !== 'append')
        ? { id: String(event.seq), role: 'start' }
        : null,
    start: (_context, match, reader) => {
      if (match.event.type === 'assistant/live-chunk') {
        throw new Error('workflow-system-message start requires a durable event')
      }
      return inspect(
        reader.previous<SystemPromptState>('workflow-system-message')?.state,
        match.event,
      )
    },
    update: context => context.state,
    publication: () => 'none',
  }
}

/** Request-header facts retained by the Workflow target. */
function workflowRequestHeaderDefinition(
  inspect: RequestPromptInspector,
): ConversationNodeDefinition<WorkflowRequestHeaderState> {
  return {
    kind: 'workflow-request-header',
    target: 'workflow',
    match: event => event.type === 'request/header'
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (_context, match, reader) => {
      if (match.event.type !== 'request/header') {
        throw new Error('workflow-request-header start requires request/header')
      }
      const previous = reader.previous<WorkflowRequestHeaderState>('workflow-request-header')
        ?.state.prompt
      const system = reader.previous<SystemPromptState>('workflow-system-message')
        ?.state.effective
      const inspection = inspect(previous, match.event, system)
      return {
        seq: match.event.seq,
        time: match.event.time,
        prompt: inspection.prompt,
        location: match.location,
        ...(inspection.change === undefined ? {} : { change: inspection.change }),
      }
    },
    update: context => context.state,
    buildViewNode: context => context.state === undefined
      ? null
      : workflowNode(context, context.state.seq, {
        kind: 'request-header',
        header: context.state,
      }),
  }
}

/**
 * Register Workflow request-header facts using the canonical prompt inspector.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerWorkflowRequestHeaderDefinition(ctx: Context): void {
  ctx.uiConversation.events.register(workflowSystemMessageDefinition(
    (previous, event) => ctx.uiConversation.inspectSystemPrompt(previous, event),
  ))
  ctx.uiConversation.events.register(workflowRequestHeaderDefinition(
    (previous, event, system) => ctx.uiConversation.inspectRequestPrompt(previous, event, system),
  ))
}
/* jscpd:ignore-end */