import { useState } from 'react';
import type { PersonaTemplate, Provider } from '../../../src/shared/model/index.js';

interface SpawnAgentDialogProps {
  roomName: string;
  roomId: string;
  personas: PersonaTemplate[];
  onSubmit: (roomId: string, name: string, personaId: string, provider: Provider) => void;
  onCancel: () => void;
}

export function SpawnAgentDialog({ roomName, roomId, personas, onSubmit, onCancel }: SpawnAgentDialogProps) {
  const [name, setName] = useState('');
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? 'lead');
  const [provider, setProvider] = useState<Provider>('copilot');

  return (
    <div className="dialog-backdrop" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">Spawn Agent</p>
        <h2>New Agent in {roomName}</h2>

        <label className="dialog-label">Agent Name</label>
        <input
          className="dialog-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Nova, Tern, Mica"
          autoFocus
        />

        <label className="dialog-label">Persona</label>
        <div className="persona-grid">
          {personas.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`persona-chip${personaId === p.id ? ' persona-chip--selected' : ''}`}
              style={{ ['--accent' as string]: p.color }}
              onClick={() => setPersonaId(p.id)}
            >
              <span className="persona-chip__dot" />
              <span>{p.title}</span>
              <small>{p.specialty}</small>
            </button>
          ))}
        </div>

        <label className="dialog-label">Provider</label>
        <div className="provider-toggle">
          <button
            type="button"
            className={`provider-opt${provider === 'copilot' ? ' provider-opt--active' : ''}`}
            onClick={() => setProvider('copilot')}
          >
            ⚡ Copilot
          </button>
          <button
            type="button"
            className={`provider-opt${provider === 'claude' ? ' provider-opt--active' : ''}`}
            onClick={() => setProvider('claude')}
          >
            🧠 Claude
          </button>
        </div>

        <div className="dialog-actions">
          <button
            type="button"
            className="composer-button"
            disabled={name.trim().length === 0}
            onClick={() => onSubmit(roomId, name.trim(), personaId, provider)}
          >
            Spawn Agent
          </button>
          <button type="button" className="composer-button composer-button--ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
