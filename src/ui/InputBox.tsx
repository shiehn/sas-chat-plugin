/**
 * InputBox — single-line `>` prompt at the bottom of the terminal.
 *
 * Behavior:
 *   - Enter submits (Shift+Enter inserts newline)
 *   - Disabled while a turn is processing
 *   - Trims whitespace; whitespace-only never sends
 *   - Clears on successful send
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

export interface InputBoxProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /**
   * When provided, the textarea re-focuses every time this flips to `true`
   * (and again whenever `disabled` flips back to `false` while expanded).
   * Lets the host accordion section drive focus on open without coupling
   * InputBox to the accordion DOM. Undefined = legacy behavior (mount-only
   * autoFocus).
   */
  isExpanded?: boolean;
}

const DEFAULT_PLACEHOLDER = 'ask anything — Enter to send, Shift+Enter for newline';

const FONT = 'JetBrains Mono, SF Mono, Menlo, Monaco, Consolas, monospace';

export const InputBox: React.FC<InputBoxProps> = ({
  onSend,
  disabled = false,
  placeholder = DEFAULT_PLACEHOLDER,
  autoFocus = true,
  isExpanded,
}) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
    // Only run on mount — refocusing on every prop change fights the user's
    // current focus target and breaks the `autoFocus={false}` contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!isExpanded) return;
    if (disabled) return;
    textareaRef.current?.focus();
  }, [isExpanded, disabled]);

  const handleSend = useCallback((): void => {
    if (disabled) return;
    const trimmed = text.trim();
    if (trimmed === '') return;
    onSend(trimmed);
    setText('');
  }, [disabled, onSend, text]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 6,
        padding: '6px 10px 8px',
        borderTop: '1px solid rgba(106, 242, 197, 0.15)',
        fontFamily: FONT,
        fontSize: 13,
      }}
    >
      <span
        aria-hidden
        style={{ color: '#6AF2C5', lineHeight: '20px', userSelect: 'none' }}
      >
        {'>'}
      </span>
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={1}
        aria-label="Chat input"
        style={{
          flex: 1,
          resize: 'none',
          minHeight: 20,
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: '#F7FFFB',
          fontFamily: FONT,
          fontSize: 13,
          lineHeight: '20px',
          padding: 0,
          opacity: disabled ? 0.5 : 1,
        }}
      />
    </div>
  );
};
