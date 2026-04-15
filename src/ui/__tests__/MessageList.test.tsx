/**
 * MessageList component spec — TDD.
 *
 * Renders an ordered list of MessageItem entries. Handles:
 *   - empty state (helpful hint)
 *   - normal state (N messages in order)
 *   - scroll-to-bottom when a new message arrives
 *   - a11y role="list"
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from '@jest/globals';
import { MessageList } from '../MessageList';
import type { ChatUIMessage } from '../types';

const fakeMessages: ChatUIMessage[] = [
  { id: '1', role: 'user', content: 'add reverb to the bass' },
  { id: '2', role: 'assistant', content: 'Added reverb to Bass.' },
  { id: '3', role: 'user', content: 'more wet' },
  { id: '4', role: 'assistant', content: 'Bumped dry/wet to 0.55.' },
];

describe('MessageList', () => {
  describe('empty state', () => {
    it('renders a helpful placeholder when no messages', () => {
      render(<MessageList messages={[]} />);
      // Agent-friendly hint: tell the user what they can do
      expect(screen.getByText(/ask|try|type/i)).not.toBeNull();
    });

    it('has role="list" even when empty (so screen readers announce the region)', () => {
      render(<MessageList messages={[]} />);
      expect(screen.getByRole('list')).not.toBeNull();
    });
  });

  describe('populated state', () => {
    it('renders every message in order', () => {
      render(<MessageList messages={fakeMessages} />);
      const items = screen.getAllByRole('listitem');
      expect(items).toHaveLength(4);
      // Order preserved
      expect(items[0].textContent).toContain('add reverb to the bass');
      expect(items[3].textContent).toContain('Bumped dry/wet');
    });

    it('uses each message id as the React key implicitly (no console warning)', () => {
      const warn = jest.spyOn(console, 'error').mockImplementation(() => {});
      render(<MessageList messages={fakeMessages} />);
      const keyWarning = warn.mock.calls.find((call) =>
        (call[0] as string | undefined)?.includes?.('unique "key"')
      );
      expect(keyWarning).toBeUndefined();
      warn.mockRestore();
    });

    it('applies data-role per item so CSS can distinguish user/assistant', () => {
      const { container } = render(<MessageList messages={fakeMessages} />);
      expect(container.querySelectorAll('[data-role="user"]')).toHaveLength(2);
      expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(2);
    });
  });

  describe('rendering assistant actions inline', () => {
    it('renders the action log inline when an assistant message has actions', () => {
      const withActions: ChatUIMessage[] = [
        {
          id: '1',
          role: 'assistant',
          content: 'Added reverb and compression.',
          actions: [
            { tool: 'dsl_set_track_fx', params: { category: 'reverb' }, result: { ok: true } },
            { tool: 'dsl_set_track_fx', params: { category: 'compressor' }, result: { ok: true } },
          ],
        },
      ];
      render(<MessageList messages={withActions} />);
      // Both actions hit the tool "dsl_set_track_fx" — getAllByText returns
      // every match; assert the count so we know the action log renders
      // each entry rather than collapsing duplicates.
      expect(screen.getAllByText(/dsl_set_track_fx/)).toHaveLength(2);
    });

    it('does not render an action log for user messages (they have no actions)', () => {
      const userOnly: ChatUIMessage[] = [{ id: '1', role: 'user', content: 'hi' }];
      render(<MessageList messages={userOnly} />);
      expect(screen.queryByTestId('action-log')).toBeNull();
    });
  });

  describe('loading indicator', () => {
    it('renders a loading indicator when isProcessing=true', () => {
      render(<MessageList messages={fakeMessages} isProcessing />);
      expect(screen.getByTestId('loading-indicator')).not.toBeNull();
    });

    it('omits the loading indicator by default', () => {
      render(<MessageList messages={fakeMessages} />);
      expect(screen.queryByTestId('loading-indicator')).toBeNull();
    });

    it('renders loading indicator AFTER the last message (chronological placement)', () => {
      render(<MessageList messages={fakeMessages} isProcessing />);
      const items = screen.getAllByRole('listitem');
      const loading = screen.getByTestId('loading-indicator');
      // loading should come after the last item in the DOM
      const lastItem = items[items.length - 1];
      expect(lastItem.compareDocumentPosition(loading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });
});
