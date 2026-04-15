/**
 * InputBox component spec — TDD.
 *
 * Textarea + send button. Responsibilities:
 *   - Call onSend with the current text when the button is clicked or Enter pressed
 *   - Disable Send when text is empty or disabled prop is true
 *   - Clear the textarea after a successful send
 *   - Handle Shift+Enter as "new line" (not send)
 *   - Show placeholder text
 *   - Be disabled while processing (prevents double-send)
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, jest } from '@jest/globals';
import { InputBox } from '../InputBox';

describe('InputBox', () => {
  describe('sending', () => {
    it('calls onSend with the current text when Send is clicked', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'add reverb' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(onSend).toHaveBeenCalledWith('add reverb');
    });

    it('sends on Enter (without Shift)', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'hi' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

      expect(onSend).toHaveBeenCalledWith('hi');
    });

    it('does NOT send on Shift+Enter (lets the user insert a newline)', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'line one' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter', shiftKey: true });

      expect(onSend).not.toHaveBeenCalled();
    });

    it('clears the textarea after a successful send', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} />);

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: 'hello' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(textarea.value).toBe('');
    });

    it('trims whitespace-only messages (does not send)', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: '   \n  ' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(onSend).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace when sending', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: '  add reverb  ' } });
      fireEvent.click(screen.getByRole('button', { name: /send/i }));

      expect(onSend).toHaveBeenCalledWith('add reverb');
    });
  });

  describe('disabled state', () => {
    it('disables Send when text is empty', () => {
      render(<InputBox onSend={jest.fn()} />);
      expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables Send once text is entered', () => {
      render(<InputBox onSend={jest.fn()} />);

      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'x' } });
      expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    it('disables Send + textarea when the disabled prop is set', () => {
      render(<InputBox onSend={jest.fn()} disabled />);
      expect((screen.getByRole('button', { name: /send/i }) as HTMLButtonElement).disabled).toBe(true);
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    });

    it('does not call onSend while disabled, even with Enter', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} disabled />);

      const textarea = screen.getByRole('textbox');
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('placeholder + labeling', () => {
    it('shows a default placeholder when none provided', () => {
      render(<InputBox onSend={jest.fn()} />);
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.placeholder).toBeTruthy();
    });

    it('respects a custom placeholder', () => {
      render(<InputBox onSend={jest.fn()} placeholder="tell me what to do" />);
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.placeholder).toBe('tell me what to do');
    });

    it('labels the send button for screen readers', () => {
      render(<InputBox onSend={jest.fn()} />);
      const btn = screen.getByRole('button', { name: /send/i });
      const accessibleName = btn.getAttribute('aria-label') || btn.textContent;
      expect(accessibleName && accessibleName.length > 0).toBe(true);
    });
  });

  describe('auto-focus', () => {
    it('focuses the textarea on mount by default', () => {
      render(<InputBox onSend={jest.fn()} />);
      expect(document.activeElement).toBe(screen.getByRole('textbox'));
    });

    it('does not auto-focus when autoFocus=false', () => {
      render(<InputBox onSend={jest.fn()} autoFocus={false} />);
      expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
    });
  });
});
