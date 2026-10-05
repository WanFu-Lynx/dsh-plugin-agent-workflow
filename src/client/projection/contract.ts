import type {
  AssistantMessageNode, ConversationLocation, ConversationNode,
  ConversationPromptSnapshot, ConversationViewNode, PartialAssistant,
  RequestPromptChange, RequestView, RunningToolCall, ToolCallBlock,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

import type { Message } from '@deepseek-ai/dsh-llm/types'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/** Assistant request enriched with Workflow-only request-boundary data. */
export type WorkflowAssistantRequest = Extract<RequestView, { purpose: 'assistant' }> & {
  /** Complete provider-neutral messages array reconstructed at dispatch. */
  readonly messages?: readonly Message[]
  /** Sequence that settled the request, including interrupted requests. */
  readonly completedSeq?: number
}

/** Provider request as consumed by the standalone Workflow projection. */
export type WorkflowRequestView =
  | WorkflowAssistantRequest
  | Extract<RequestView, { purpose: 'compaction' }>

/** Request-header facts retained by the Workflow target. */
export interface WorkflowRequestHeaderState {
  readonly seq: number
  readonly time: number
  readonly prompt: ConversationPromptSnapshot
  readonly change?: RequestPromptChange
  readonly location: ConversationLocation
}

/** One model-visible surface operation retained for request-boundary reconstruction. */
export interface WorkflowSurfaceRecord {
  readonly seq: number
  readonly message: Message | null
  readonly operation:
    | { readonly kind: 'append' }
    | { readonly kind: 'replace'; readonly start: number; readonly end: number }
}

/** One independently assembled contribution to the legacy Workflow ledger. */
export type WorkflowContribution =
  | {
    readonly kind: 'node'
    readonly node: ConversationNode
  }
  | {
    readonly kind: 'assistant'
    readonly node?: AssistantMessageNode
    readonly partial: PartialAssistant | null
    readonly request?: WorkflowAssistantRequest
  }
  | {
    readonly kind: 'tool'
    readonly root: ToolCallBlock
  }
  | {
    readonly kind: 'request-header'
    readonly header: WorkflowRequestHeaderState
  }
  | {
    readonly kind: 'surface'
    readonly record: WorkflowSurfaceRecord
  }
  | {
    readonly kind: 'compaction'
    readonly request: Extract<WorkflowRequestView, { purpose: 'compaction' }>
  }
  | {
    readonly kind: 'session-end'
    readonly seq: number
    readonly time: number
  }
  | {
    readonly kind: 'turn-end'
    readonly turn: number
    readonly time: number
    readonly error?: string
  }

/** Target envelope consumed by the Workflow snapshot builder. */
export interface WorkflowConversationViewNode extends ConversationViewNode {
  readonly target: 'workflow'
  readonly anchorSeq: number
  readonly location: ConversationLocation
  readonly data: WorkflowContribution
}

/** Stage-oriented Workflow data assembled from registered business Contexts. */
export interface WorkflowSnapshot {
  readonly eventNodes: readonly ConversationNode[]
  readonly eventLocations: ReadonlyMap<number, ConversationLocation>
  readonly requests: readonly WorkflowRequestView[]
  readonly callSchemas: ReadonlyMap<string, ConversationPromptSnapshot['tools'][number]>
  readonly partial: PartialAssistant | null
  readonly runningCalls: readonly RunningToolCall[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Independently assembled data consumed by the Workflow view. */
    workflow: WorkflowSnapshot
  }
}

/** Selector hook over the current Conversation binding's Workflow target. */
export type UseWorkflow = SnapshotSelectorHook<WorkflowSnapshot>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Session's Workflow target snapshot. */
    useWorkflow: UseWorkflow
  }
}
