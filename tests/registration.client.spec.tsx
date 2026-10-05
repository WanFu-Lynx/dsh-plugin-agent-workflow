// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply, inject } from '../src/client/index.ts'
import { WorkflowToolResult, WorkflowView } from '../src/client/WorkflowView.tsx'
import { EMPTY_WORKFLOW_SNAPSHOT } from '../src/client/projection/snapshot-builder.ts'

afterEach(cleanup)

function bench() {
  const eventDefinitions: { kind: string }[] = []
  const viewDefinitions: { target: string }[] = []
  const slotEntries: {
    options: {
      id: string
      order: number
      label: () => string
      inject: (id: SessionId) => unknown
    }
  }[] = []
  const session = {
    getSnapshot: () => ({ marker: 1 }),
    loadOlder: () => Promise.resolve(),
  }
  const target = {
    getSnapshot: () => EMPTY_WORKFLOW_SNAPSHOT,
    subscribe: () => () => {},
  }
  const ctx = {
    effect: (install: () => () => void) => install(),
    locale: {
      register: () => () => {},
      bind: () => (key: string) => key === 'view.workflow' ? 'Workflow' : key,
    },
    uiConversation: {
      events: {
        register: (definition: { kind: string }) => {
          eventDefinitions.push(definition)
          return () => {}
        },
      },
      views: {
        register: (definition: { target: string }) => {
          viewDefinitions.push(definition)
          return () => {}
        },
      },
      binding: () => ({ target: () => target }),
    },
    sessions: { binding: () => ({ session }) },
    uiSession: { provide: () => () => {} },
    slots: {
      inject: (_name: string, install: () => () => void) => install(),
      register: (options: typeof slotEntries[number]['options']) => {
        const entry = { options }
        slotEntries.push(entry)
        return () => {}
      },
    },
  } as unknown as Context
  apply(ctx)
  return { eventDefinitions, viewDefinitions, slotEntries }
}

describe('Workflow plugin registration', () => {
  it('registers only the independently installable Workflow tab', () => {
    const result = bench()
    const entry = result.slotEntries.at(0)
    expect(inject).toEqual(['slots', 'sessions', 'uiConversation', 'uiSession', 'locale'])
    expect(entry?.options.id).toBe('workflow')
    expect(entry?.options.order).toBe(15)
    expect(entry?.options.label()).toBe('Workflow')
    expect(entry?.options.inject('session-1' as SessionId)).toMatchObject({ loadOlder: expect.any(Function) })
    expect(result.viewDefinitions.map(definition => definition.target)).toContain('workflow')
    expect(result.eventDefinitions.some(definition => definition.kind === 'workflow-assistant-step')).toBe(true)
  })

  it('switches a tool result from live loading to completed success', () => {
    const view = render(<WorkflowToolResult status="running" label="进行中" duration="—" />)
    const running = view.container.querySelector('[data-tool-status="running"]')
    expect(running?.getAttribute('aria-live')).toBe('polite')
    expect(running?.querySelector('svg')?.classList.contains('lucide-loader-circle')).toBe(true)

    view.rerender(<WorkflowToolResult status="complete" label="完成" duration="500ms" />)
    const completed = view.container.querySelector('[data-tool-status="complete"]')
    expect(completed?.querySelector('svg')?.classList.contains('lucide-circle-check')).toBe(true)
    expect(view.container.querySelector('[data-tool-status="running"]')).toBeNull()
  })

  it('opts into the conversation height contract so its internal panes can scroll', () => {
    const snapshot = {
      hasMore: false,
      loadingOlder: false,
    }
    const props = {
      useSession: (selector: (value: typeof snapshot) => unknown) => selector(snapshot),
      useWorkflow: (selector: (value: typeof EMPTY_WORKFLOW_SNAPSHOT) => unknown) =>
        selector(EMPTY_WORKFLOW_SNAPSHOT),
      loadOlder: () => Promise.resolve(false),
      t: (key: string) => key,
    } as unknown as ComponentProps<typeof WorkflowView>

    const view = render(<WorkflowView {...props} />)
    expect(view.getByRole('region', { name: 'workflow.aria' })
      .getAttribute('data-conversation-composer-overlay')).toBe('')
  })
})
