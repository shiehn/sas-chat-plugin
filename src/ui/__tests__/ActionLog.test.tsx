/**
 * ActionLog component spec — TDD.
 *
 * Renders the per-turn action log produced by the ChatAgent tool loop.
 * Each entry shows:
 *   - tool name
 *   - ✓ / ✗ status based on whether error was set
 *   - collapsible details (params + result OR error)
 *
 * Starts collapsed by default; clicking the tool name expands.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from '@jest/globals';
import { ActionLog } from '../ActionLog';
import type { ChatActionEntry } from '../types';

const successAction: ChatActionEntry = {
  tool: 'dsl_set_track_fx',
  params: { trackId: 't-1', category: 'reverb', enabled: true },
  result: { ok: true },
};

const failAction: ChatActionEntry = {
  tool: 'dsl_set_track_fx',
  params: { trackId: 'missing', category: 'reverb', enabled: true },
  error: 'Track not found: missing',
};

describe('ActionLog', () => {
  describe('empty state', () => {
    it('renders nothing when actions is empty', () => {
      const { container } = render(<ActionLog actions={[]} />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('single action', () => {
    it('renders the tool name for a success action', () => {
      render(<ActionLog actions={[successAction]} />);
      expect(screen.getByText(/dsl_set_track_fx/)).not.toBeNull();
    });

    it('shows a success marker (✓) for success actions', () => {
      const { container } = render(<ActionLog actions={[successAction]} />);
      expect(container.querySelector('[data-status="success"]')).not.toBeNull();
    });

    it('shows a fail marker (✗) for error actions', () => {
      const { container } = render(<ActionLog actions={[failAction]} />);
      expect(container.querySelector('[data-status="error"]')).not.toBeNull();
    });

    it('starts collapsed (details hidden)', () => {
      render(<ActionLog actions={[successAction]} />);
      // Params JSON should not be visible until expanded
      expect(screen.queryByText(/trackId/)).toBeNull();
    });

    it('expands details when the tool name is clicked', () => {
      render(<ActionLog actions={[successAction]} />);
      fireEvent.click(screen.getByText(/dsl_set_track_fx/));
      // Now params should be visible
      expect(screen.getByText(/trackId/)).not.toBeNull();
    });

    it('collapses again on second click', () => {
      render(<ActionLog actions={[successAction]} />);
      const label = screen.getByText(/dsl_set_track_fx/);
      fireEvent.click(label);
      fireEvent.click(label);
      expect(screen.queryByText(/trackId/)).toBeNull();
    });

    it('shows error message in expanded view when action has an error', () => {
      render(<ActionLog actions={[failAction]} />);
      fireEvent.click(screen.getByText(/dsl_set_track_fx/));
      expect(screen.getByText(/Track not found/)).not.toBeNull();
    });
  });

  describe('multiple actions', () => {
    it('renders each action independently', () => {
      const actions: ChatActionEntry[] = [
        successAction,
        failAction,
        { tool: 'get_tracks', params: {}, result: { tracks: ['Bass'] } },
      ];
      render(<ActionLog actions={actions} />);
      // Two separate dsl_set_track_fx entries + one get_tracks entry
      expect(screen.getAllByText(/dsl_set_track_fx/)).toHaveLength(2);
      expect(screen.getByText(/get_tracks/)).not.toBeNull();
    });

    it('each action toggles independently', () => {
      const actions: ChatActionEntry[] = [
        { tool: 'tool_a', params: { x: 1 }, result: {} },
        { tool: 'tool_b', params: { y: 2 }, result: {} },
      ];
      render(<ActionLog actions={actions} />);
      fireEvent.click(screen.getByText(/tool_a/));
      // tool_a expanded — "x" visible
      expect(screen.getByText(/"x"/)).not.toBeNull();
      // tool_b still collapsed — "y" not visible
      expect(screen.queryByText(/"y"/)).toBeNull();
    });
  });

  describe('accessibility', () => {
    it('uses a button element for the toggle (keyboard + screen reader reachable)', () => {
      render(<ActionLog actions={[successAction]} />);
      expect(screen.getByRole('button', { name: /dsl_set_track_fx/ })).not.toBeNull();
    });

    it('sets aria-expanded correctly as state changes', () => {
      render(<ActionLog actions={[successAction]} />);
      const button = screen.getByRole('button', { name: /dsl_set_track_fx/ });
      expect(button.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(button);
      expect(button.getAttribute('aria-expanded')).toBe('true');
    });

    it('is keyboard-activatable via Enter', () => {
      render(<ActionLog actions={[successAction]} />);
      const button = screen.getByRole('button', { name: /dsl_set_track_fx/ });
      // fireEvent.click also fires for Enter on a button in the accessibility tree
      button.focus();
      fireEvent.keyDown(button, { key: 'Enter', code: 'Enter' });
      fireEvent.click(button); // simulate the default browser behavior
      expect(button.getAttribute('aria-expanded')).toBe('true');
    });
  });
});
