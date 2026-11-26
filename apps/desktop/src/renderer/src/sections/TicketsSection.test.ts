// @vitest-environment jsdom

import {
  type Department,
  type RendererApi,
  type ReviewQueue,
  type TicketView,
} from '@ticket/shared';
import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TicketsSection from './TicketsSection.vue';

const department: Department = {
  id: 'billing',
  name: 'Billing',
  description: 'Invoices',
  active: true,
  aliases: [],
  examples: [],
};

function ticket(
  id: string,
  subject: string,
  status: 'labeled' | 'needs_review' | 'overridden' | 'failed',
  createdAt: string,
): TicketView {
  const applied = status === 'labeled' || status === 'overridden';
  return {
    id,
    externalId: `external-${id}`,
    subject,
    body: `${subject} body`,
    channel: 'email',
    createdAt,
    email: null,
    decision: {
      departmentId: applied ? 'billing' : null,
      confidence: status === 'failed' ? 0 : 0.4,
      rationale: status === 'failed' ? 'The model could not be reached.' : 'Uncertain.',
      status,
      quote: null,
      taxonomyVersion: 1,
      categoryId: null,
      replacedCategoryId: null,
      categoryReviewed: false,
      priority: null,
      replacedPriority: null,
      priorityReviewed: false,
    },
  };
}

const needsReview = ticket(
  '00000000-0000-4000-8000-000000000001',
  'Old needs review',
  'needs_review',
  '2026-01-01T00:00:00.000Z',
);
const failed = ticket(
  '00000000-0000-4000-8000-000000000002',
  'Newer failed',
  'failed',
  '2026-01-02T00:00:00.000Z',
);
const resolved = ticket(needsReview.id, needsReview.subject, 'overridden', needsReview.createdAt);

function installApi(
  queue: ReviewQueue,
  options: {
    readonly afterOverride?: ReviewQueue;
    readonly afterCategory?: TicketView;
  } = {},
) {
  let overridden = false;
  const api = {
    listTickets: vi.fn(async () => []),
    listDepartments: vi.fn(async () => [department]),
    listCategories: vi.fn(async () => [
      {
        id: 'outage',
        name: 'Outage',
        description: 'Service down',
        active: true,
        defaultPriority: 'urgent',
        examples: [],
      },
    ]),
    reviewQueue: vi.fn(async () => (overridden ? (options.afterOverride ?? queue) : queue)),
    ticketContext: vi.fn(async () => ({
      email: null,
      prior: [],
      summary: { tickets: 0, byDepartment: [], overridden: 0 },
    })),
    overrideTicket: vi.fn(async () => {
      overridden = true;
      return resolved;
    }),
    setTicketCategory: vi.fn(async () => options.afterCategory ?? needsReview),
    setTicketPriority: vi.fn(async () => needsReview),
  } as unknown as RendererApi;
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TicketsSection review queue', () => {
  it('shows counts oldest-first and refreshes after a department override', async () => {
    const initial: ReviewQueue = {
      counts: { needsReview: 1, failed: 1 },
      tickets: [needsReview, failed],
    };
    const remaining: ReviewQueue = {
      counts: { needsReview: 0, failed: 1 },
      tickets: [failed],
    };
    const api = installApi(initial, { afterOverride: remaining });
    const wrapper = mount(TicketsSection);
    await flushPromises();

    expect(wrapper.get('[data-testid="review-total"]').text()).toBe('2');
    await wrapper.get('[data-testid="view-review"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="review-counts"]').text()).toContain(
      '2 unresolved · 1 needs review · 1 failed',
    );
    expect(wrapper.findAll('button.subject').map((button) => button.text())).toEqual([
      'Old needs review',
      'Newer failed',
    ]);

    await wrapper.findAll('button.subject')[0]?.trigger('click');
    await flushPromises();
    await wrapper.get('form.override select').setValue('billing');
    await wrapper.get('form.override').trigger('submit');
    await flushPromises();

    expect(api.overrideTicket).toHaveBeenCalledWith({ id: needsReview.id, departmentId: 'billing' });
    expect(wrapper.get('[data-testid="review-total"]').text()).toBe('1');
    expect(wrapper.findAll('button.subject').map((button) => button.text())).toEqual(['Newer failed']);
  });

  it('keeps a needs_review ticket in the queue after a category correction', async () => {
    const initial: ReviewQueue = {
      counts: { needsReview: 1, failed: 1 },
      tickets: [needsReview, failed],
    };
    const categorized: TicketView = {
      ...needsReview,
      decision: {
        ...needsReview.decision,
        categoryId: 'outage',
        categoryReviewed: true,
        replacedCategoryId: null,
      },
    };
    const api = installApi(initial, { afterCategory: categorized });
    const wrapper = mount(TicketsSection);
    await flushPromises();
    await wrapper.get('[data-testid="view-review"]').trigger('click');
    await flushPromises();
    await wrapper.findAll('button.subject')[0]?.trigger('click');
    await flushPromises();

    await wrapper.get('[data-testid="set-category"]').setValue('outage');
    await wrapper.get('[data-testid="ticket-review"] form.review-row').trigger('submit');
    await flushPromises();

    expect(api.setTicketCategory).toHaveBeenCalledWith({ id: needsReview.id, categoryId: 'outage' });
    expect(api.overrideTicket).not.toHaveBeenCalled();
    expect(wrapper.get('[data-testid="review-total"]').text()).toBe('2');
    expect(wrapper.findAll('button.subject').map((button) => button.text())).toEqual([
      'Old needs review',
      'Newer failed',
    ]);
  });

  it('shows the component empty state when no ticket needs review', async () => {
    installApi({ counts: { needsReview: 0, failed: 0 }, tickets: [] });
    const wrapper = mount(TicketsSection);
    await flushPromises();
    await wrapper.get('[data-testid="view-review"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[data-testid="review-total"]').text()).toBe('0');
    expect(wrapper.get('[data-testid="review-empty"]').text()).toContain('Nothing to review');
  });
});
