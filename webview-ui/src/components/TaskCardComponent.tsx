import { useEffect, useRef } from 'react';

import type {
  CommandExecutionResult,
  PersonaTemplate,
  ProposedFileEdit,
  SquadAgent,
  Room,
  TaskCard,
  TaskExecutionPlan,
  TaskStatus,
} from '../../../src/shared/model/index.js';

export interface TaskCardProps {
  task: TaskCard;
  agentsById: Map<string, SquadAgent>;
  personas: Map<string, PersonaTemplate>;
  rooms: Room[];
  expandedTaskId: string | null;
  setExpandedTaskId: (id: string | null) => void;
  streamingOutputs: Record<string, string>;
  allTasks: TaskCard[];
  vscode: { postMessage(message: unknown): void };
}

function taskProgressForStatus(status: TaskStatus) {
  switch (status) {
    case 'queued':
      return { value: 1, total: 5, label: 'Queued' };
    case 'active':
      return { value: 2, total: 5, label: 'Executing' };
    case 'review':
      return { value: 4, total: 5, label: 'Review' };
    case 'done':
      return { value: 5, total: 5, label: 'Complete' };
    case 'failed':
      return { value: 5, total: 5, label: 'Failed' };
  }
}

function isCardActivation(event: React.KeyboardEvent<HTMLElement>): boolean {
  return event.key === 'Enter' || event.key === ' ';
}

function taskActions(task: TaskCard): Array<{ label: string; action: string }> {
  switch (task.status) {
    case 'queued':
      return [{ label: '▶ Execute', action: 'execute' }];
    case 'active':
      return [{ label: '✗ Fail', action: 'fail' }];
    case 'review':
      return [
        { label: '✓ Approve', action: 'complete' },
        ...(task.executionPlan?.terminalCommands.length
          ? [{
              label: task.executionPlan.commandResults.some((result) => result.status !== 'pending')
                ? '↻ Re-run Commands'
                : '⌘ Run Commands',
              action: 'run',
            }]
          : []),
        { label: '✗ Reject', action: 'fail' },
      ];
    case 'failed':
      return [{ label: '↻ Retry', action: 'retry' }];
    case 'done':
      return [{ label: '↻ Re-open', action: 'retry' }];
    default:
      return [];
  }
}

function planHasArtifacts(plan: TaskExecutionPlan | undefined): boolean {
  return Boolean(
    plan && (plan.fileEdits.length > 0 || plan.terminalCommands.length > 0 || plan.tests.length > 0 || plan.notes.length > 0)
  );
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
      <p className="eyebrow">Command Results</p>
      {results.map((result, index) => (
        <article key={`${task.id}-result-${index}`} className={`task-plan__item task-plan__item--${result.status}`}>
          <strong>{result.command}</strong>
          <span>{commandResultLabel(result)}</span>
          {result.output ? <pre className="task-plan__output">{result.output}</pre> : null}
        </article>
      ))}
    </div>
  );
}

function changedFilesForTask(task: TaskCard): string[] {
  return Array.from(new Set(task.executionPlan?.fileEdits.map((edit) => edit.filePath) ?? []));
}

function sourceLabel(task: TaskCard): string {
  if (task.source === 'copilot-chat') {
    return 'Chat';
  }
  if (task.source === 'claude-chat') {
    return 'Claude Chat';
  }
  return 'Panel';
}

export function TaskCardComponent({
  task,
  agentsById,
  personas,
  rooms,
  expandedTaskId,
  setExpandedTaskId,
  streamingOutputs,
  allTasks,
  vscode,
}: TaskCardProps) {
  const assignee = agentsById.get(task.assigneeId);
  const persona = assignee ? personas.get(assignee.personaId) : null;
  const roomName = assignee ? rooms.find((room) => room.id === assignee.roomId)?.name ?? 'No Room' : 'No Room';
  const dependencyCount = task.dependsOn?.length ?? 0;
  const progress = task.progress ?? taskProgressForStatus(task.status);
  const progressWidth = `${Math.max(0, Math.min(100, (progress.value / progress.total) * 100))}%`;
  const isActiveProgress = task.status === 'active';
  const isExpanded = expandedTaskId === task.id;
  const changedFiles = changedFilesForTask(task);
  const cardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isExpanded) {
      return;
    }
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  }, [isExpanded]);

  const handleToggle = () => {
    setExpandedTaskId(isExpanded ? null : task.id);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!isCardActivation(event)) return;
    event.preventDefault();
    handleToggle();
  };

  return (
    <article
      ref={cardRef}
      className={`task-card task-card--${task.status}${isExpanded ? ' task-card--expanded' : ''}`}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-expanded={isExpanded}
      aria-label={`Task: ${task.title}, status: ${task.status}, assigned to ${assignee?.name ?? 'unassigned'}`}
    >
      <div className="task-meta">
        <span className={`status-badge status-badge--${task.status}`}>{task.status}</span>
        <span className={`provider-badge provider-badge--${task.provider}`}>
          {task.provider === 'copilot' ? '⚡' : '🧠'} {task.provider}
        </span>
        <span className="task-chip">{sourceLabel(task)}</span>
        {task.toolPreference === 'mcp-first' ? (
          <span
            className={`task-chip task-chip--mcp${task.toolPreferenceReason === 'forced' ? ' task-chip--mcp-forced' : ''}`}
            title={task.toolPreferenceReason === 'forced' ? 'Forced by workspace setting' : 'Detected external-access task'}
          >
            MCP-first
          </span>
        ) : null}
        {task.batchId ? <span className="task-chip">Run</span> : null}
        {dependencyCount > 0 ? <span className="task-chip">Depends on {dependencyCount}</span> : null}
        {task.approvalState ? <span className="task-chip">{task.approvalState}</span> : null}
      </div>

      <div className="task-card__topline">
        <div className="task-card__headline">
          <h3>{task.title}</h3>
          <span className="task-card__room">{roomName}</span>
        </div>
        <span className="task-card__progress-chip">{progress.label}</span>
      </div>

      <p className="task-card__detail">{task.detail}</p>

      {changedFiles.length > 0 ? (
        <div className="task-meta">
          <span className="task-chip">Changed files</span>
          {changedFiles.slice(0, 3).map((filePath) => (
            <span key={`${task.id}-${filePath}`} className="task-chip" title={filePath}>{filePath}</span>
          ))}
          {changedFiles.length > 3 ? <span className="task-chip">+{changedFiles.length - 3} more</span> : null}
        </div>
      ) : null}

      <div className="task-card__footer">
        <div className="task-card__identity">
          <strong>{assignee?.name ?? 'Unassigned'}</strong>
          <span>{persona?.title ?? 'Unknown persona'}</span>
        </div>
        <div className={`task-progress${isActiveProgress ? ' task-progress--active' : ''}`} title={progress.label}>
          <div className="task-progress__bar">
            <div className={`task-progress__fill${isActiveProgress ? ' task-progress__fill--active' : ''}`} style={{ width: progressWidth }} />
          </div>
          <span>{progress.label} · {Math.min(progress.value, progress.total)}/{progress.total}</span>
        </div>
      </div>

      {task.status === 'active' && streamingOutputs[task.id] && (
        <div className="task-output task-output--stream" aria-live="polite" aria-atomic="false">
          <p className="eyebrow">Live output</p>
          <pre className="task-stream-pre">
            {streamingOutputs[task.id]}
            <span className="task-stream-cursor" aria-hidden="true" />
          </pre>
        </div>
      )}

      {task.output && isExpanded && (
        <div className="task-output">
          <p className="eyebrow">Execution Output</p>
          <pre>{task.output}</pre>
        </div>
      )}

      {isExpanded && task.workspaceContext ? (
        <div className="task-plan">
          <p className="eyebrow">Workspace Context</p>
          <p className="task-plan__line">Branch: {task.workspaceContext.branch || 'unknown'}</p>
          <p className="task-plan__line">Active file: {task.workspaceContext.activeFile || 'none'}</p>
          {task.workspaceContext.gitStatus?.length ? (
            <p className="task-plan__line">Git: {task.workspaceContext.gitStatus.join(' | ')}</p>
          ) : null}
          {task.workspaceContext.relevantFiles.length ? (
            <div className="task-plan__list">
              {task.workspaceContext.relevantFiles.map((file) => (
                <article key={file.path} className="task-plan__item">
                  <strong>{file.path}</strong>
                  <span>{file.reason}</span>
                </article>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {isExpanded && task.handoffPackets && task.handoffPackets.length > 0 ? (
        <div className="task-plan">
          <p className="eyebrow">Handoff from predecessors</p>
          {task.handoffPackets.map((packet) => (
            <article key={packet.fromTaskId} className="task-plan__item">
              <strong>From {packet.fromAgentName}</strong>
              <span>{packet.summary}</span>
              {packet.filesChanged.length > 0 ? (
                <p className="task-plan__line">Files: {packet.filesChanged.join(', ')}</p>
              ) : null}
              {packet.openIssues.length > 0 ? (
                <p className="task-plan__line">Notes: {packet.openIssues.join('; ')}</p>
              ) : null}
            </article>
          ))}
        </div>
      ) : null}

      {isExpanded && (task.dependsOn?.length ?? 0) > 0 ? (
        <div className="dep-chain">
          <p className="eyebrow">Chain of Dependencies</p>
          <div className="dep-chain__nodes">
            {task.dependsOn!.map((depId) => {
              const depTask = allTasks.find((t) => t.id === depId);
              const depAgent = depTask ? agentsById.get(depTask.assigneeId) : null;
              return depTask ? (
                <div key={depId} className="dep-chain__entry">
                  <div className="dep-chain__node">
                    <span className={`dep-chain__badge dep-chain__badge--${depTask.status}`}>{depTask.status}</span>
                    <span className="dep-chain__title">{depTask.title}</span>
                    {depAgent ? <span className="dep-chain__agent">{depAgent.name}</span> : null}
                  </div>
                  <span className="dep-chain__arrow" aria-hidden="true">→</span>
                </div>
              ) : null;
            })}
            <div className="dep-chain__node dep-chain__node--self">
              <span className={`dep-chain__badge dep-chain__badge--${task.status}`}>{task.status}</span>
              <span className="dep-chain__title">{task.title}</span>
            </div>
          </div>
        </div>
      ) : null}

      {isExpanded && planHasArtifacts(task.executionPlan) ? (
        <div className="task-plan">
          <p className="eyebrow">Proposed Changes</p>
          <p className="task-plan__summary">{task.executionPlan?.summary}</p>
          {task.executionPlan?.fileEdits.length ? (
            <div className="task-diff-list">
              {task.executionPlan.fileEdits.map((edit) => (
                <article key={`${task.id}-${edit.filePath}`} className="task-diff-card">
                  <div className="task-diff-card__header">
                    <strong>
                      {edit.action.toUpperCase()} {edit.filePath}
                    </strong>
                    <span>{edit.summary}</span>
                  </div>
                  <div className="task-diff-card__code">
                    {buildPreviewLines(edit).map((line, index) => (
                      <div
                        key={`${task.id}-${edit.filePath}-${index}`}
                        className={`task-diff-card__row task-diff-card__row--${line.kind}`}
                      >
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
          {task.executionPlan?.terminalCommands.length ? (
            <div className="task-plan__list">
              {task.executionPlan.terminalCommands.map((command, index) => (
                <article key={`${task.id}-command-${index}`} className="task-plan__item">
                  <strong>{command.command}</strong>
                  <span>{command.summary}</span>
                </article>
              ))}
            </div>
          ) : null}
          {renderCommandResults(task)}
          {task.executionPlan?.tests.length ? (
            <p className="task-plan__line">Tests: {task.executionPlan.tests.join(' | ')}</p>
          ) : null}
          {task.executionPlan?.notes.length ? (
            <p className="task-plan__line">Notes: {task.executionPlan.notes.join(' | ')}</p>
          ) : null}
        </div>
      ) : null}

      <div className="task-controls" onClick={(e) => e.stopPropagation()} role="group" aria-label="Task actions">
        {taskActions(task).map(({ label, action }) => (
          <button
            key={action}
            type="button"
            className={`control-btn control-btn--${action}`}
            onClick={() => vscode.postMessage({ type: 'taskAction', taskId: task.id, action })}
            aria-label={`${label} task: ${task.title}`}
          >
            {label}
          </button>
        ))}
      </div>
    </article>
  );
}
