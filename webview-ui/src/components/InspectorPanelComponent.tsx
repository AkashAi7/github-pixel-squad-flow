import type {
  PersonaTemplate,
  ProposedFileEdit,
  Room,
  SquadAgent,
  TaskCard,
  TaskExecutionPlan,
  CommandExecutionResult,
} from '../../../src/shared/model/index.js';
import { AGENT_MOOD } from '../../../src/shared/model/index.js';

export interface InspectorPanelProps {
  selectedAgent: SquadAgent | null;
  selectedAgentTasks: TaskCard[];
  selectedAgentFocusTask: TaskCard | undefined;
  personas: Map<string, PersonaTemplate>;
  rooms: Room[];
  inspectorTab: 'overview' | 'assign' | 'work';
  setInspectorTab: (tab: 'overview' | 'assign' | 'work') => void;
  agentTaskPrompt: string;
  setAgentTaskPrompt: (prompt: string) => void;
  isAssigning: boolean;
  setIsAssigning: (value: boolean) => void;
  expandedTaskId: string | null;
  setExpandedTaskId: (id: string | null) => void;
  showFilePicker: boolean;
  setShowFilePicker: (value: boolean) => void;
  fileSearchQuery: string;
  setFileSearchQuery: (query: string) => void;
  workspaceFiles: string[];
  streamingOutputs: Record<string, string>;
  vscode: { postMessage(message: unknown): void };
}

function agentActions(agent: SquadAgent): Array<{ label: string; action: string }> {
  switch (agent.status) {
    case 'executing':
    case 'planning':
      return [{ label: '⏸ Pause', action: 'pause' }, { label: '✓ Complete', action: 'complete' }];
    case 'paused':
      return [{ label: '▶ Resume', action: 'resume' }, { label: '✓ Complete', action: 'complete' }];
    case 'failed':
    case 'blocked':
      return [{ label: '↻ Retry', action: 'retry' }];
    case 'waiting':
      return [{ label: '✓ Complete', action: 'complete' }];
    default:
      return [];
  }
}

function isCardActivation(event: React.KeyboardEvent<HTMLElement>): boolean {
  return event.key === 'Enter' || event.key === ' ';
}

function planHasArtifacts(plan: TaskExecutionPlan | undefined): boolean {
  return Boolean(plan && (plan.fileEdits.length > 0 || plan.terminalCommands.length > 0 || plan.tests.length > 0 || plan.notes.length > 0));
}

type DiffPreviewLine = {
  kind: 'context' | 'add' | 'remove';
  before?: number;
  after?: number;
  content: string;
};

function buildPreviewLines(edit: ProposedFileEdit, contextWindow = 3, maxCreateLines = 40): DiffPreviewLine[] {
  const splitLines = (value: string | undefined) => (value ?? '').replace(/\r/g, '').split('\n');
  const proposedLines = splitLines(edit.content);

  if (edit.action === 'create' || edit.originalContent === undefined) {
    return proposedLines.slice(0, maxCreateLines).map((content, index) => ({
      kind: 'add',
      after: index + 1,
      content,
    }));
  }

  const originalLines = splitLines(edit.originalContent);
  let prefix = 0;
  while (prefix < originalLines.length && prefix < proposedLines.length && originalLines[prefix] === proposedLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < originalLines.length - prefix &&
    suffix < proposedLines.length - prefix &&
    originalLines[originalLines.length - 1 - suffix] === proposedLines[proposedLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  if (prefix === originalLines.length && prefix === proposedLines.length) {
    return originalLines.slice(0, Math.min(originalLines.length, contextWindow * 2)).map((content, index) => ({
      kind: 'context',
      before: index + 1,
      after: index + 1,
      content,
    }));
  }

  const previewLines: DiffPreviewLine[] = [];
  const sharedStart = Math.max(0, prefix - contextWindow);
  for (let index = sharedStart; index < prefix; index += 1) {
    previewLines.push({
      kind: 'context',
      before: index + 1,
      after: index + 1,
      content: originalLines[index],
    });
  }

  const originalChangedEnd = Math.max(prefix, originalLines.length - suffix);
  for (let index = prefix; index < originalChangedEnd; index += 1) {
    previewLines.push({
      kind: 'remove',
      before: index + 1,
      content: originalLines[index],
    });
  }

  const proposedChangedEnd = Math.max(prefix, proposedLines.length - suffix);
  for (let index = prefix; index < proposedChangedEnd; index += 1) {
    previewLines.push({
      kind: 'add',
      after: index + 1,
      content: proposedLines[index],
    });
  }

  const trailingCount = Math.min(contextWindow, suffix);
  const originalTrailingStart = originalLines.length - trailingCount;
  const proposedTrailingStart = proposedLines.length - trailingCount;
  for (let index = 0; index < trailingCount; index += 1) {
    previewLines.push({
      kind: 'context',
      before: originalTrailingStart + index + 1,
      after: proposedTrailingStart + index + 1,
      content: originalLines[originalTrailingStart + index],
    });
  }

  return previewLines;
}

function lineMarker(kind: DiffPreviewLine['kind']): string {
  if (kind === 'add') return '+';
  if (kind === 'remove') return '-';
  return ' ';
}

function commandResultLabel(result: CommandExecutionResult): string {
  if (result.status === 'succeeded') {
    return `Succeeded${typeof result.exitCode === 'number' ? ` (exit ${result.exitCode})` : ''}`;
  }
  if (result.status === 'failed') {
    return `Failed${typeof result.exitCode === 'number' ? ` (exit ${result.exitCode})` : ''}`;
  }
  if (result.status === 'running') {
    return 'Running';
  }
  return 'Pending';
}

function renderCommandResults(task: TaskCard) {
  const results = task.executionPlan?.commandResults ?? [];
  if (!results.length) {
    return null;
  }

  return (
    <div className="task-plan__list">
      {results.map((result) => (
        <article key={`${task.id}-command-result-${result.commandIndex}`} className={`task-command-result task-command-result--${result.status}`}>
          <div className="task-command-result__header">
            <strong>{result.command}</strong>
            <span className={`task-command-result__status task-command-result__status--${result.status}`}>{commandResultLabel(result)}</span>
          </div>
          <span>{result.summary}</span>
          {typeof result.durationMs === 'number' ? <p className="task-plan__line">Duration: {result.durationMs} ms</p> : null}
          {result.stdout ? (
            <div className="task-output task-output--compact">
              <p className="eyebrow">stdout</p>
              <pre>{result.stdout}</pre>
            </div>
          ) : null}
          {result.stderr ? (
            <div className="task-output task-output--compact">
              <p className="eyebrow">stderr</p>
              <pre>{result.stderr}</pre>
            </div>
          ) : null}
        </article>
      ))}
    </div>
  );
}

export function InspectorPanelComponent({
  selectedAgent,
  selectedAgentTasks,
  selectedAgentFocusTask,
  personas,
  rooms,
  inspectorTab,
  setInspectorTab,
  agentTaskPrompt,
  setAgentTaskPrompt,
  isAssigning,
  setIsAssigning,
  expandedTaskId,
  setExpandedTaskId,
  showFilePicker,
  setShowFilePicker,
  fileSearchQuery,
  setFileSearchQuery,
  workspaceFiles,
  streamingOutputs,
  vscode,
}: InspectorPanelProps) {
  return (
    <section className="panel inspector-panel">
      <p className="eyebrow">Selected Agent</p>
      {selectedAgent ? (
        <>
          <div className="inspector-header-row">
            <h2>
              {selectedAgent.name}
              <span className="agent-mood-inline" title={AGENT_MOOD[selectedAgent.status].label}>
                {AGENT_MOOD[selectedAgent.status].emoji}
              </span>
            </h2>
            <div className="persona-pill" style={{ ['--accent' as string]: personas.get(selectedAgent.personaId)?.color ?? '#7d8cff' }}>
              {personas.get(selectedAgent.personaId)?.title ?? selectedAgent.personaId}
            </div>
            <span className={`provider-badge provider-badge--${selectedAgent.provider}`}>
              {selectedAgent.provider === 'copilot' ? '⚡ Copilot' : '🧠 Claude'}
            </span>
          </div>

          {/* ── Inline Assign (always visible) ── */}
          <div className="inspector-quick-assign">
            <textarea
              className="inspector-quick-assign__input"
              value={agentTaskPrompt}
              onChange={(e) => setAgentTaskPrompt(e.target.value)}
              placeholder={`Assign a task to ${selectedAgent.name}…`}
              rows={2}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && agentTaskPrompt.trim().length > 0) {
                  setIsAssigning(true);
                  vscode.postMessage({ type: 'assignTask', agentId: selectedAgent.id, prompt: agentTaskPrompt.trim() });
                  setAgentTaskPrompt('');
                }
              }}
            />
            <button
              type="button"
              className="inspector-quick-assign__btn"
              disabled={isAssigning || agentTaskPrompt.trim().length === 0}
              onClick={() => {
                setIsAssigning(true);
                vscode.postMessage({ type: 'assignTask', agentId: selectedAgent.id, prompt: agentTaskPrompt.trim() });
                setAgentTaskPrompt('');
              }}
            >
              {isAssigning ? '…' : `⚡ Assign`}
            </button>
          </div>

          {/* ── Inspector Tab Bar ── */}
          <div
            className="inspector-tabs"
            role="tablist"
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                setInspectorTab(inspectorTab === 'overview' ? 'work' : 'overview');
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                setInspectorTab(inspectorTab === 'work' ? 'overview' : 'work');
              }
            }}
          >
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === 'overview'}
              tabIndex={inspectorTab === 'overview' ? 0 : -1}
              className={`inspector-tabs__tab${inspectorTab === 'overview' ? ' inspector-tabs__tab--active' : ''}`}
              onClick={() => setInspectorTab('overview')}
            >
              Overview
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={inspectorTab === 'work'}
              tabIndex={inspectorTab === 'work' ? 0 : -1}
              className={`inspector-tabs__tab${inspectorTab === 'work' ? ' inspector-tabs__tab--active' : ''}`}
              onClick={() => setInspectorTab('work')}
            >
              Work <strong>{selectedAgentTasks.length}</strong>
            </button>
          </div>

          {/* ── Tab: Overview ── */}
          {inspectorTab === 'overview' && (
            <div className="inspector-tab-content">
              {personas.get(selectedAgent.personaId)?.isCustom ? <div className="task-chip">Custom Agent</div> : null}
              {personas.get(selectedAgent.personaId)?.skills?.length ? (
                <div className="skill-row">
                  {personas.get(selectedAgent.personaId)?.skills?.map((skill) => (
                    <span key={skill.id} className="skill-pill">
                      {skill.label}
                      <strong>L{skill.level}</strong>
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="inspector-copy">{selectedAgent.summary}</p>
              <dl className="facts">
                <div><dt>Provider</dt><dd>{selectedAgent.provider}</dd></div>
                <div><dt>Status</dt><dd><span className={`status-badge status-badge--${selectedAgent.status}`}>{selectedAgent.status}</span></dd></div>
                <div><dt>Room</dt><dd>{rooms.find((r) => r.id === selectedAgent.roomId)?.name}</dd></div>
                <div><dt>Mood</dt><dd>{AGENT_MOOD[selectedAgent.status].emoji} {AGENT_MOOD[selectedAgent.status].label}</dd></div>
              </dl>
              <section className="inspector-spotlight">
                <p className="eyebrow">Current Focus</p>
                {selectedAgentFocusTask ? (
                  <div className="inspector-spotlight__card">
                    <div className="inspector-spotlight__meta">
                      <span className={`status-badge status-badge--${selectedAgentFocusTask.status}`}>{selectedAgentFocusTask.status}</span>
                      <span className={`provider-badge provider-badge--${selectedAgentFocusTask.provider}`}>
                        {selectedAgentFocusTask.provider === 'copilot' ? '⚡' : '🧠'} {selectedAgentFocusTask.provider}
                      </span>
                    </div>
                    <strong>{selectedAgentFocusTask.title}</strong>
                    <p>{selectedAgentFocusTask.detail}</p>
                    {selectedAgentFocusTask.status === 'active' && streamingOutputs[selectedAgentFocusTask.id] && (
                      <div className="task-output task-output--stream">
                        <p className="eyebrow">Live output</p>
                        <pre className="task-stream-pre">{streamingOutputs[selectedAgentFocusTask.id]}<span className="task-stream-cursor" aria-hidden="true" /></pre>
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="inspector-copy">No active assignment. Switch to the <strong>⚡ Assign</strong> tab to give this agent work.</p>
                )}
              </section>
              <div className="agent-controls">
                {agentActions(selectedAgent).map(({ label, action }) => (
                  <button
                    key={action}
                    type="button"
                    className={`control-btn control-btn--${action}`}
                    onClick={() => vscode.postMessage({ type: 'agentAction', agentId: selectedAgent.id, action })}
                  >{label}</button>
                ))}
              </div>
              <details className="inspector-section">
                <summary>
                  <span>Pinned Context Files</span>
                  <strong>{(selectedAgent.pinnedFiles ?? []).length}</strong>
                </summary>
                <div className="agent-pinned-files">
                {(selectedAgent.pinnedFiles ?? []).length > 0 ? (
                  <div className="pinned-file-list">
                    {(selectedAgent.pinnedFiles ?? []).map((filePath) => (
                      <div key={filePath} className="pinned-file-item">
                        <span className="pinned-file-item__path" title={filePath}>{filePath}</span>
                        <button
                          type="button"
                          className="pinned-file-item__remove"
                          title="Unpin"
                          onClick={() => {
                            const updated = (selectedAgent.pinnedFiles ?? []).filter((f) => f !== filePath);
                            vscode.postMessage({ type: 'pinFiles', agentId: selectedAgent.id, files: updated });
                          }}
                        >✕</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="inspector-copy">No files pinned.</p>
                )}
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    type="button"
                    className="composer-button composer-button--ghost"
                    title="Pin the file currently open in the editor"
                    onClick={() => {
                      vscode.postMessage({ type: 'pinActiveFile', agentId: selectedAgent.id });
                    }}
                  >📎 Pin Active File</button>
                  <button
                    type="button"
                    className="composer-button composer-button--ghost"
                    onClick={() => {
                      setShowFilePicker(true);
                      setFileSearchQuery('');
                      vscode.postMessage({ type: 'requestWorkspaceFiles' });
                    }}
                  >📌 Pin Files</button>
                </div>
                {showFilePicker && (
                  <div className="file-picker-overlay" onClick={() => setShowFilePicker(false)}>
                    <div className="file-picker" onClick={(e) => e.stopPropagation()}>
                      <p className="eyebrow">Select files to pin to {selectedAgent.name}</p>
                      <input
                        className="file-picker__search"
                        type="text"
                        placeholder="Search files..."
                        value={fileSearchQuery}
                        onChange={(e) => setFileSearchQuery(e.target.value)}
                        autoFocus
                      />
                      <div className="file-picker__list">
                        {workspaceFiles
                          .filter((f) => !fileSearchQuery || f.toLowerCase().includes(fileSearchQuery.toLowerCase()))
                          .slice(0, 30)
                          .map((filePath) => {
                            const isPinned = (selectedAgent.pinnedFiles ?? []).includes(filePath);
                            return (
                              <button
                                key={filePath}
                                type="button"
                                className={`file-picker__item${isPinned ? ' file-picker__item--pinned' : ''}`}
                                onClick={() => {
                                  const current = selectedAgent.pinnedFiles ?? [];
                                  const updated = isPinned
                                    ? current.filter((f) => f !== filePath)
                                    : [...current, filePath];
                                  vscode.postMessage({ type: 'pinFiles', agentId: selectedAgent.id, files: updated });
                                }}
                              >
                                <span>{isPinned ? '📌 ' : ''}{filePath}</span>
                              </button>
                            );
                          })}
                        {workspaceFiles.length === 0 && <p className="inspector-copy">Loading workspace files...</p>}
                      </div>
                      <button
                        type="button"
                        className="composer-button"
                        onClick={() => setShowFilePicker(false)}
                      >Done</button>
                    </div>
                  </div>
                )}
                </div>
              </details>
            </div>
          )}

          {/* ── Tab: Assign ── */}
          {inspectorTab === 'assign' && (
            <div className="inspector-tab-content">
              <div className="assign-task assign-task--prominent">
                <label className="composer-label" htmlFor="agent-task-prompt">⚡ Assign task to {selectedAgent.name}</label>
                <textarea
                  id="agent-task-prompt"
                  className="assign-task__input"
                  value={agentTaskPrompt}
                  onChange={(e) => setAgentTaskPrompt(e.target.value)}
                  placeholder={`Describe a task for ${selectedAgent.name}...`}
                  rows={4}
                  autoFocus
                />
                <button
                  type="button"
                  className="composer-button assign-task__btn"
                  disabled={isAssigning || agentTaskPrompt.trim().length === 0}
                  onClick={() => {
                    setIsAssigning(true);
                    vscode.postMessage({ type: 'assignTask', agentId: selectedAgent.id, prompt: agentTaskPrompt.trim() });
                    setAgentTaskPrompt('');
                  }}
                >
                  {isAssigning ? 'Assigning...' : `⚡ Assign to ${selectedAgent.name}`}
                </button>
                <p className="inspector-copy" style={{ marginTop: '8px' }}>
                  This assigns a task directly to <strong>{selectedAgent.name}</strong>, bypassing the planner.
                  Use "Route Task" in the hero composer to let the planner decide assignment.
                </p>
              </div>
            </div>
          )}

          {/* ── Tab: Work ── */}
          {inspectorTab === 'work' && (
            <div className="inspector-tab-content">
              <div className="agent-work">
                {selectedAgentTasks.length === 0 ? <p className="inspector-copy">No tasks assigned yet.</p> : null}
                {selectedAgentTasks.length > 0 ? (
                  <div className="agent-work__list">
                    {selectedAgentTasks.map((task) => (
                      <article
                        key={task.id}
                        className={`agent-work__task agent-work__task--${task.status}${expandedTaskId === task.id ? ' agent-work__task--expanded' : ''}`}
                        onClick={() => setExpandedTaskId(expandedTaskId === task.id ? null : task.id)}
                        onKeyDown={(event) => {
                          if (!isCardActivation(event)) return;
                          event.preventDefault();
                          setExpandedTaskId(expandedTaskId === task.id ? null : task.id);
                        }}
                        role="button"
                        tabIndex={0}
                        aria-expanded={expandedTaskId === task.id}
                      >
                        <div className="agent-work__meta">
                          <span className={`status-badge status-badge--${task.status}`}>{task.status}</span>
                          <span className="agent-work__title">{task.title}</span>
                        </div>
                        <p className="agent-work__detail">{task.detail}</p>
                        {task.status === 'active' && streamingOutputs[task.id] && (
                          <div className="task-output task-output--stream">
                            <p className="eyebrow">Live output</p>
                            <pre className="task-stream-pre">{streamingOutputs[task.id]}<span className="task-stream-cursor" aria-hidden="true" /></pre>
                          </div>
                        )}
                        {task.output && expandedTaskId === task.id && (
                          <div className="task-output">
                            <p className="eyebrow">Output</p>
                            <pre>{task.output}</pre>
                          </div>
                        )}
                        {expandedTaskId === task.id && planHasArtifacts(task.executionPlan) ? (
                          <div className="task-plan">
                            <p className="eyebrow">Execution Plan</p>
                            <p className="task-plan__summary">{task.executionPlan?.summary}</p>
                            {task.executionPlan?.fileEdits.length ? (
                              <div className="task-diff-list">
                                {task.executionPlan.fileEdits.map((edit) => (
                                  <article key={`${task.id}-${edit.filePath}`} className="task-diff-card">
                                    <div className="task-diff-card__header">
                                      <strong>{edit.action.toUpperCase()} {edit.filePath}</strong>
                                      <span>{edit.summary}</span>
                                    </div>
                                    <div className="task-diff-card__code">
                                      {buildPreviewLines(edit).map((line, index) => (
                                        <div key={`${task.id}-${edit.filePath}-${index}`} className={`task-diff-card__row task-diff-card__row--${line.kind}`}>
                                          <span className="task-diff-card__gutter">{line.before ?? ''}</span>
                                          <span className="task-diff-card__gutter">{line.after ?? ''}</span>
                                          <span className="task-diff-card__marker">{lineMarker(line.kind)}</span>
                                          <code>{line.content || ' '}</code>
                                        </div>
                                      ))}
                                    </div>
                                  </article>
                                ))}
                              </div>
                            ) : null}
                            {task.executionPlan?.terminalCommands.length ? <p className="task-plan__line">Commands: {task.executionPlan.terminalCommands.map((command) => command.command).join(' ; ')}</p> : null}
                            {renderCommandResults(task)}
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </>
      ) : (
        <p className="inspector-copy">Pick an agent from the factory floor to inspect it.</p>
      )}
    </section>
  );
}
