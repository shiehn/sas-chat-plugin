/**
 * InputBox spec — CLI-style prompt.
 *
 * Textarea only (no Send button). Enter submits, Shift+Enter inserts a
 * newline, whitespace-only input never sends, disabled blocks submit.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, jest } from '@jest/globals';
import { InputBox } from '../InputBox';

describe('InputBox', () => {
  describe('sending', () => {
    it('sends on Enter (without Shift)', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'hi' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

      expect(onSend).toHaveBeenCalledWith('hi');
    });

    it('does NOT send on Shift+Enter', () => {
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
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

      expect(textarea.value).toBe('');
    });

    it('does not send whitespace-only messages', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: '   \n  ' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

      expect(onSend).not.toHaveBeenCalled();
    });

    it('trims surrounding whitespace', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: '  add reverb  ' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

      expect(onSend).toHaveBeenCalledWith('add reverb');
    });
  });

  describe('disabled state', () => {
    it('disables the textarea when disabled prop is set', () => {
      render(<InputBox onSend={jest.fn()} disabled />);
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    });

    it('does not call onSend while disabled', () => {
      const onSend = jest.fn();
      render(<InputBox onSend={onSend} disabled />);

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'x' } });
      fireEvent.keyDown(textarea, { key: 'Enter', code: 'Enter' });

      expect(onSend).not.toHaveBeenCalled();
    });
  });

  describe('placeholder', () => {
    it('shows a default placeholder', () => {
      render(<InputBox onSend={jest.fn()} />);
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.placeholder).toBeTruthy();
    });

    it('respects a custom placeholder', () => {
      render(<InputBox onSend={jest.fn()} placeholder="tell me what to do" />);
      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.placeholder).toBe('tell me what to do');
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

    it('re-focuses the textarea when isExpanded flips false → true', () => {
      const { rerender } = render(
        <InputBox onSend={jest.fn()} autoFocus={false} isExpanded={false} />,
      );
      // Collapsed + no mount autoFocus = textarea is not focused.
      const textarea = screen.getByRole('textbox');
      expect(document.activeElement).not.toBe(textarea);

      // Simulate the user clicking elsewhere before the panel opens.
      const decoy = document.createElement('button');
      document.body.appendChild(decoy);
      decoy.focus();
      expect(document.activeElement).toBe(decoy);

      // Now the host expands the section.
      rerender(<InputBox onSend={jest.fn()} autoFocus={false} isExpanded={true} />);
      expect(document.activeElement).toBe(textarea);

      document.body.removeChild(decoy);
    });

    it('does NOT focus when isExpanded is true but disabled', () => {
      render(<InputBox onSend={jest.fn()} autoFocus={false} isExpanded={true} disabled />);
      expect(document.activeElement).not.toBe(screen.getByRole('textbox'));
    });
  });
});
