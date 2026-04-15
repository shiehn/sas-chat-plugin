/**
 * InputBox — textarea + Send button.
 *
 * Behavior:
 *   - Enter submits (Shift+Enter inserts newline)
 *   - Button disabled when empty or props.disabled
 *   - Trims whitespace; whitespace-only never sends
 *   - Clears on successful send
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';

export interface InputBoxProps {
  onSend: (message: string) => void;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
}

const DEFAULT_PLACEHOLDER = 'Ask the assistant… (Enter to send, Shift+Enter for newline)';

export const InputBox: React.FC<InputBoxProps> = ({
  onSend,
  disabled = false,
  placeholder = DEFAULT_PLACEHOLDER,
  autoFocus = true,
}) => {
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

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

  const sendDisabled = disabled || text.trim() === '';

  return (
    <div
      style={{
        display: 'flex',
        gap: 6,
        padding: 8,
        borderTop: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <textarea
        ref={textareaRef}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        rows={2}
        style={{
          flex: 1,
          resize: 'vertical',
          minHeight: 36,
          fontFamily: 'inherit',
          fontSize: 13,
          padding: '6px 8px',
        }}
      />
      <button
        type="button"
        onClick={handleSend}
        disabled={sendDisabled}
        aria-label="Send message"
        style={{
          alignSelf: 'flex-end',
          padding: '6px 14px',
          fontSize: 13,
          cursor: sendDisabled ? 'not-allowed' : 'pointer',
          opacity: sendDisabled ? 0.5 : 1,
        }}
      >
        Send
      </button>
    </div>
  );
};
