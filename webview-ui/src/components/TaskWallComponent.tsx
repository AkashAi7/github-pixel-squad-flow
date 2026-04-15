import type {
  PersonaTemplate,
  Provider,
  Room,
  SquadAgent,
  TaskCard,
  TaskStatus,
} from '../../../src/shared/model/index.js';
import { TaskCardComponent } from './TaskCardComponent.js';

export const TASK_STATUS_ORDER: TaskStatus[] = ['active', 'queued', 'review', 'done', 'failed'];

export type TaskGroupBy = 'status' | 'assignee' | 'room';

export interface TaskGroup {
  key: string;
  label: string;
  tasks: TaskCard[];
}

export interface TaskWallProps {
  taskGroupBy: TaskGroupBy;
  setTaskGroupBy: (groupBy: TaskGroupBy) => void;
  taskStatusFilter: TaskStatus | 'all';
  setTaskStatusFilter: (filter: TaskStatus | 'all') => void;
  taskProviderFilter: Provider | 'all';
  setTaskProviderFilter: (filter: Provider | 'all') => void;
  taskPersonaFilter: string;
  setTaskPersonaFilter: (filter: string) => void;
  taskGroups: TaskGroup[];
  agentsById: Map<string, SquadAgent>;
  personas: PersonaTemplate[];
  rooms: Room[];
  expandedTaskId: string | null;
  setExpandedTaskId: (id: string | null) => void;
  streamingOutputs: Record<string, string>;
  allTasks: TaskCard[];
  vscode: { postMessage(message: unknown): void };
}

export function TaskWallComponent({
  taskGroupBy,
  setTaskGroupBy,
  taskStatusFilter,
  setTaskStatusFilter,
  taskProviderFilter,
  setTaskProviderFilter,
  taskPersonaFilter,
  setTaskPersonaFilter,
  taskGroups,
  agentsById,
  personas,
  rooms,
  expandedTaskId,
  setExpandedTaskId,
  streamingOutputs,
  allTasks,
  vscode,
}: TaskWallProps) {
  const personasMap = new Map(personas.map((p) => [p.id, p]));

  return (
    <section className="workspace-stack">
      <aside className="column column--side column--stacked">
        <section className="panel">
          <div className="task-wall__header">
            <div>
              <p className="eyebrow">Task Wall</p>
              <p className="task-wall__copy">
                Group and filter the queue without losing assignee, dependency, or progress context.
              </p>
            </div>
            <div className="task-wall__modes">
              <button
                type="button"
                className={`toggle-chip${taskGroupBy === 'status' ? ' toggle-chip--active' : ''}`}
                onClick={() => setTaskGroupBy('status')}
              >
                By status
              </button>
              <button
                type="button"
                className={`toggle-chip${taskGroupBy === 'assignee' ? ' toggle-chip--active' : ''}`}
                onClick={() => setTaskGroupBy('assignee')}
              >
                By agent
              </button>
              <button
                type="button"
                className={`toggle-chip${taskGroupBy === 'room' ? ' toggle-chip--active' : ''}`}
                onClick={() => setTaskGroupBy('room')}
              >
                By room
              </button>
            </div>
          </div>
          <div className="task-filters">
            <label className="task-filter">
              <span>Status</span>
              <select
                value={taskStatusFilter}
                onChange={(event) => setTaskStatusFilter(event.target.value as TaskStatus | 'all')}
              >
                <option value="all">All</option>
                {TASK_STATUS_ORDER.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label className="task-filter">
              <span>Provider</span>
              <select
                value={taskProviderFilter}
                onChange={(event) => setTaskProviderFilter(event.target.value as Provider | 'all')}
              >
                <option value="all">All</option>
                <option value="copilot">Copilot</option>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label className="task-filter">
              <span>Persona</span>
              <select
                value={taskPersonaFilter}
                onChange={(event) => setTaskPersonaFilter(event.target.value)}
              >
                <option value="all">All</option>
                {personas.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {persona.title}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="task-group-list">
            {taskGroups.length === 0 ? (
              <p className="task-wall__empty">No tasks match the current filters.</p>
            ) : null}
            {taskGroups.map((group) => (
              <section key={group.key} className="task-group">
                <div className="task-group__header">
                  <h3>{group.label}</h3>
                  <span>{group.tasks.length}</span>
                </div>
                <div className="task-list">
                  {group.tasks.map((task) => (
                    <TaskCardComponent
                      key={task.id}
                      task={task}
                      agentsById={agentsById}
                      personas={personasMap}
                      rooms={rooms}
                      expandedTaskId={expandedTaskId}
                      setExpandedTaskId={setExpandedTaskId}
                      streamingOutputs={streamingOutputs}
                      allTasks={allTasks}
                      vscode={vscode}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      </aside>
    </section>
  );
}
