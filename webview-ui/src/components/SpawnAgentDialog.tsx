import { useEffect, useState } from 'react';
import type { CustomPersonaDraft, PersonaTemplate, Provider, TaskCard } from '../../../src/shared/model/index.js';

interface SpawnAgentDialogProps {
  roomName: string;
  roomId: string;
  roomTasks: TaskCard[];
  personas: PersonaTemplate[];
  onSubmit: (roomId: string, name: string, personaId: string, provider: Provider, customPersona?: CustomPersonaDraft, assignTaskId?: string) => void;
  onCancel: () => void;
}

export function SpawnAgentDialog({ roomName, roomId, roomTasks, personas, onSubmit, onCancel }: SpawnAgentDialogProps) {
  const [name, setName] = useState('');
  const [personaId, setPersonaId] = useState(personas[0]?.id ?? 'lead');
  const [provider, setProvider] = useState<Provider>('copilot');
  const [assignTaskId, setAssignTaskId] = useState('');
  const [useCustomPersona, setUseCustomPersona] = useState(false);
  const [customTitle, setCustomTitle] = useState('');
  const [customSpecialty, setCustomSpecialty] = useState('');
  const [customColor, setCustomColor] = useState('#ff9f68');
  const [customSkills, setCustomSkills] = useState('');

  const customPersona = useCustomPersona
    ? {
        title: customTitle.trim() || 'Custom Agent',
        specialty: customSpecialty.trim() || 'Custom workflow specialist',
        color: customColor,
        skills: customSkills.split(',').map((label, index) => label.trim()).filter(Boolean).map((label, index) => ({
          id: `custom-skill-${index + 1}`,
          label,
          level: 3,
        })),
      }
    : undefined;

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
    <div className="dialog-backdrop" onClick={onCancel} role="dialog" aria-modal="true" aria-labelledby="spawn-agent-title">
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">Spawn Agent</p>
        <h2 id="spawn-agent-title">New Agent in {roomName}</h2>

        <label className="dialog-label">Agent Name</label>
        <input
          className="dialog-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Nova, Tern, Mica"
          autoFocus
        />

        <label className="dialog-label">Persona</label>
        <label className="dialog-toggle">
          <input
            type="checkbox"
            checked={useCustomPersona}
            onChange={(event) => setUseCustomPersona(event.target.checked)}
          />
          <span>Create custom agent persona</span>
        </label>
        {useCustomPersona ? (
          <div className="custom-persona-form">
            <label className="dialog-label">Custom Title</label>
            <input
              className="dialog-input"
              value={customTitle}
              onChange={(event) => setCustomTitle(event.target.value)}
              placeholder="e.g. Release Captain"
            />
            <label className="dialog-label">Specialty</label>
            <input
              className="dialog-input"
              value={customSpecialty}
              onChange={(event) => setCustomSpecialty(event.target.value)}
              placeholder="e.g. Release orchestration and rollout validation"
            />
            <label className="dialog-label">Color</label>
            <input
              className="dialog-input dialog-input--color"
              type="color"
              value={customColor}
              onChange={(event) => setCustomColor(event.target.value)}
            />
            <label className="dialog-label">Skills</label>
            <input
              className="dialog-input"
              value={customSkills}
              onChange={(event) => setCustomSkills(event.target.value)}
              placeholder="e.g. release, incident, compliance"
            />
          </div>
        ) : null}
        <div className="persona-grid">
          {personas.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`persona-chip${!useCustomPersona && personaId === p.id ? ' persona-chip--selected' : ''}`}
              style={{ ['--accent' as string]: p.color }}
              onClick={() => {
                setUseCustomPersona(false);
                setPersonaId(p.id);
              }}
            >
              <span className="persona-chip__dot" />
              <span>{p.title}{p.isCustom ? ' · custom' : ''}</span>
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

        {roomTasks.length > 0 ? (
          <>
            <label className="dialog-label">Auto-assign queued task</label>
            <select
              className="dialog-input"
              value={assignTaskId}
              onChange={(event) => setAssignTaskId(event.target.value)}
            >
              <option value="">No automatic task assignment</option>
              {roomTasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title.length > 72 ? `${task.title.slice(0, 69)}...` : task.title}
                </option>
              ))}
            </select>
            <p className="inspector-copy">Move one queued room task to this new agent immediately after spawn.</p>
          </>
        ) : null}

        <div className="dialog-actions">
          <button
            type="button"
            className="composer-button"
            disabled={name.trim().length === 0}
            onClick={() => onSubmit(roomId, name.trim(), personaId, provider, customPersona, assignTaskId || undefined)}
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
