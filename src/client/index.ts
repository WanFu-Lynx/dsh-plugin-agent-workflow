/** Browser plugin registering the visual Workflow conversation view. */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, NS, zh } from './locales.ts'
import { registerWorkflowAssistantDefinition } from './projection/assistant-definition.ts'
import { registerWorkflowCompactionDefinitions } from './projection/compaction-definition.ts'
import { registerWorkflowMessageDefinitions } from './projection/message-definitions.ts'
import { registerWorkflowRequestHeaderDefinition } from './projection/request-header-definition.ts'
import {
  EMPTY_WORKFLOW_SNAPSHOT, registerWorkflowConversationView,
} from './projection/snapshot-builder.ts'
import { registerWorkflowSurfaceDefinition } from './projection/surface-definition.ts'
import { registerWorkflowToolDefinition } from './projection/tool-definition.ts'
import { WorkflowView, type WorkflowViewInjected } from './WorkflowView.tsx'
import type { WorkflowSnapshot } from './projection/contract.ts'

export { WorkflowJsonInspector } from './WorkflowJsonInspector.tsx'
export { WorkflowToolResult, WorkflowView } from './WorkflowView.tsx'
export type { WorkflowViewInjected } from './WorkflowView.tsx'
export { deriveWorkflowModel } from './workflow-model.ts'
export type {
  WorkflowCallModel, WorkflowCallUsage, WorkflowModel, WorkflowStatus,
  WorkflowTurnModel, WorkflowTurnTimings,
} from './workflow-model.ts'
export type { WorkflowKey } from './locales.ts'

/** Required services: view slots, Conversation assembly, Session UI source, Session paging, and localization. */
export const inject = ['slots', 'sessions', 'uiConversation', 'uiSession', 'locale']

/** Register the independently installable Workflow view tab. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-workflow: dictionaries')
  registerWorkflowMessageDefinitions(ctx)
  registerWorkflowSurfaceDefinition(ctx)
  registerWorkflowRequestHeaderDefinition(ctx)
  registerWorkflowAssistantDefinition(ctx)
  registerWorkflowToolDefinition(ctx)
  registerWorkflowCompactionDefinitions(ctx)
  registerWorkflowConversationView(ctx)
  const t = ctx.locale.bind(NS)

  interface WorkflowSource {
    getSnapshot(): WorkflowSnapshot
    subscribe(listener: () => void): () => void
  }
  const workflowSources = new WeakMap<SessionBinding, WorkflowSource>()
  const workflowSource = (binding: SessionBinding): WorkflowSource => {
    let source = workflowSources.get(binding)
    if (source === undefined) {
      const target = ctx.uiConversation.binding(binding).target('workflow')
      source = {
        getSnapshot: () => target.getSnapshot() ?? EMPTY_WORKFLOW_SNAPSHOT,
        subscribe: listener => target.subscribe(listener),
      }
      workflowSources.set(binding, source)
    }
    return source
  }
  ctx.uiSession.provide({
    hooks: ['workflow'],
    resolve: binding => ({ hooks: { workflow: workflowSource(binding) } }),
  })

  const loadOlder = (sessionId: SessionId): (() => Promise<boolean>) => {
    const session = ctx.sessions.binding(sessionId)?.session
    if (session === undefined) {
      throw new Error(`ui-workflow: session "${sessionId}" is unavailable`)
    }
    const workflow = ctx.uiConversation.binding(sessionId).target('workflow')
    return async () => {
      const before = workflow.getSnapshot()
      await session.loadOlder()
      return workflow.getSnapshot() !== before
    }
  }
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'workflow',
    order: 15,
    locale: NS,
    label: () => t('view.workflow'),
    inject: (sessionId: SessionId): WorkflowViewInjected => ({
      loadOlder: loadOlder(sessionId),
    }),
  }, WorkflowView))
}