import { useEffect, useState } from 'react';
import type { RoomTheme } from '../../../src/shared/model/index.js';

const THEMES: Array<{ value: RoomTheme; label: string; icon: string }> = [
  { value: 'frontend', label: 'Frontend Lab', icon: '⚛' },
  { value: 'backend', label: 'Backend Engine', icon: '⚙' },
  { value: 'devops', label: 'DevOps Pit', icon: '🚀' },
  { value: 'testing', label: 'QA Chamber', icon: '🧪' },
  { value: 'design', label: 'Design Studio', icon: '🎨' },
  { value: 'general', label: 'War Room', icon: '📋' },
];

interface CreateRoomDialogProps {
  onSubmit: (name: string, theme: RoomTheme, purpose: string) => void;
  onCancel: () => void;
}

export function CreateRoomDialog({ onSubmit, onCancel }: CreateRoomDialogProps) {
  const [name, setName] = useState('');
  const [theme, setTheme] = useState<RoomTheme>('general');
  const [purpose, setPurpose] = useState('');

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div className="dialog-backdrop" onClick={onCancel} role="dialog" aria-modal="true" aria-labelledby="create-room-title">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">Create Room</p>
        <h2 id="create-room-title">New Factory Room</h2>

        <label className="dialog-label">Room Name</label>
        <input
          className="dialog-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Frontend Forge"
          autoFocus
        />

        <label className="dialog-label">Theme</label>
        <div className="theme-grid">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              className={`theme-chip${theme === t.value ? ' theme-chip--selected' : ''}`}
              onClick={() => setTheme(t.value)}
            >
              <span className="theme-chip__icon">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <label className="dialog-label">Purpose</label>
        <textarea
          className="dialog-textarea"
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="What kind of work happens in this room?"
        />

        <div className="dialog-actions">
          <button
            type="button"
            className="composer-button"
            disabled={name.trim().length === 0}
            onClick={() => onSubmit(name.trim(), theme, purpose.trim())}
          >
            Create Room
          </button>
          <button type="button" className="composer-button composer-button--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
