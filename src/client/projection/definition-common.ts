import type { ConversationNodeContext } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  WorkflowContribution, WorkflowConversationViewNode,
} from './contract.ts'

/**
 * Wrap one contribution in the Engine-owned target envelope.
 *
 * @param context - Context that owns the contribution identity.
 * @param anchorSeq - Sequence used to order the contribution.
 * @param data - Workflow-specific contribution payload.
 * @returns The contribution wrapped as a Workflow view node.
 */
export function workflowNode(
  context: ConversationNodeContext,
  anchorSeq: number,
  data: WorkflowContribution,
): WorkflowConversationViewNode {
  return {
    key: context.key,
    kind: context.kind,
    id: context.id,
    target: 'workflow',
    anchorSeq,
    location: context.start?.location ?? { kind: 'unresolved' },
    data,
  }
}
