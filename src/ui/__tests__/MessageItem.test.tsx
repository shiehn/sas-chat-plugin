/**
 * MessageItem component spec — TDD.
 *
 * Renders a single chat message. Three variants:
 *   - role="user"      → right-aligned bubble
 *   - role="assistant" → left-aligned bubble
 *   - role="system"    → muted / centered (for errors, scene-change notices)
 *
 * a11y: every message has a role="listitem" and readable text content.
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from '@jest/globals';
import { MessageItem } from '../MessageItem';

describe('MessageItem', () => {
  describe('role variants', () => {
    it('renders user message content verbatim', () => {
      render(<MessageItem role="user" content="add reverb to the bass" />);
      expect(screen.getByText('add reverb to the bass')).not.toBeNull();
    });

    it('renders assistant message content', () => {
      render(<MessageItem role="assistant" content="Added reverb to Bass." />);
      expect(screen.getByText('Added reverb to Bass.')).not.toBeNull();
    });

    it('renders system message content', () => {
      render(<MessageItem role="system" content="Switched scenes" />);
      expect(screen.getByText('Switched scenes')).not.toBeNull();
    });

    it('sets data-role for styling discrimination', () => {
      const { container } = render(<MessageItem role="user" content="hi" />);
      expect(container.querySelector('[data-role="user"]')).not.toBeNull();
    });

    it('tags different roles with different data-role values', () => {
      const { rerender, container } = render(<MessageItem role="user" content="a" />);
      expect(container.querySelector('[data-role="user"]')).not.toBeNull();

      rerender(<MessageItem role="assistant" content="a" />);
      expect(container.querySelector('[data-role="assistant"]')).not.toBeNull();

      rerender(<MessageItem role="system" content="a" />);
      expect(container.querySelector('[data-role="system"]')).not.toBeNull();
    });
  });

  describe('accessibility', () => {
    it('has role="listitem" so it fits inside a message list', () => {
      render(<MessageItem role="user" content="x" />);
      expect(screen.getByRole('listitem')).not.toBeNull();
    });

    it('exposes the role as an aria-label prefix for screen readers', () => {
      const { container } = render(<MessageItem role="assistant" content="hi" />);
      const item = container.querySelector('[role="listitem"]');
      expect(item?.getAttribute('aria-label')).toMatch(/assistant/i);
    });
  });

  describe('content handling', () => {
    it('preserves newlines in content', () => {
      render(<MessageItem role="assistant" content={'line 1\nline 2\nline 3'} />);
      // whiteSpace: pre-wrap — newlines preserved as rendered whitespace
      const text = screen.getByText(/line 1\s+line 2\s+line 3/);
      expect(text).not.toBeNull();
    });

    it('renders empty content without crashing', () => {
      const { container } = render(<MessageItem role="user" content="" />);
      expect(container.querySelector('[role="listitem"]')).not.toBeNull();
    });

    it('escapes HTML — no innerHTML injection', () => {
      render(<MessageItem role="user" content="<script>alert('pwn')</script>" />);
      // Literal text; no <script> in DOM
      expect(screen.getByText("<script>alert('pwn')</script>")).not.toBeNull();
      expect(document.querySelector('script')).toBeNull();
    });

    it('renders long content without truncation', () => {
      const long = 'word '.repeat(200).trim();
      render(<MessageItem role="assistant" content={long} />);
      expect(screen.getByText(long)).not.toBeNull();
    });
  });

  describe('timestamps (optional)', () => {
    it('renders timestamp when provided', () => {
      render(<MessageItem role="user" content="x" timestamp="14:23" />);
      expect(screen.getByText('14:23')).not.toBeNull();
    });

    it('omits timestamp when not provided', () => {
      const { container } = render(<MessageItem role="user" content="x" />);
      expect(container.querySelector('[data-testid="timestamp"]')).toBeNull();
    });
  });
});
