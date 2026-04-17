import type { ProviderHealth, SquadAgent, TaskCard } from '../../../src/shared/model/index.js';
import { AgentSprite } from './AgentSprite.js';

export interface ProvidersViewProps {
  providers: ProviderHealth[];
  agents: SquadAgent[];
  tasks: TaskCard[];
  stats: {
    copilot: number;
    claude: number;
    active: number;
  };
  totalAgents: number;
}

type LaneStateTone = 'active' | 'queued' | 'blocked' | 'idle' | 'review';

interface LaneState {
  tone: LaneStateTone;
  task?: TaskCard;
  reason: string;
}

function mostRelevantTask(tasks: TaskCard[], agentId: string): TaskCard | undefined {
  const agentTasks = tasks
    .filter((task) => task.assigneeId === agentId)
    .sort((left, right) => (right.updatedAt ?? right.createdAt ?? 0) - (left.updatedAt ?? left.createdAt ?? 0));

  return agentTasks.find((task) => task.status === 'active')
    ?? agentTasks.find((task) => task.status === 'review')
    ?? agentTasks.find((task) => task.status === 'queued')
    ?? agentTasks.find((task) => task.status === 'failed')
    ?? agentTasks[0];
}

function deriveLaneState(agent: SquadAgent, tasks: TaskCard[]): LaneState {
  const focusTask = mostRelevantTask(tasks, agent.id);
  if (!focusTask) {
    return { tone: 'idle', reason: 'No stage assigned in the current queue.' };
  }

  if (focusTask.status === 'active') {
    return { tone: 'active', task: focusTask, reason: 'Executing now.' };
  }

  if (focusTask.status === 'review') {
    return { tone: 'review', task: focusTask, reason: 'Awaiting review or approval.' };
  }

  if (focusTask.status === 'queued') {
    const blockingDeps = (focusTask.dependsOn ?? []).filter((dependencyId) => {
      const dependency = tasks.find((task) => task.id === dependencyId);
      return dependency && dependency.status !== 'done';
    });

    if (blockingDeps.length > 0) {
      return {
        tone: 'blocked',
        task: focusTask,
        reason: `Waiting on ${blockingDeps.length} dependency${blockingDeps.length === 1 ? '' : 'ies'}.`,
      };
    }

    return { tone: 'queued', task: focusTask, reason: 'Queued and ready to start.' };
  }

  return { tone: 'blocked', task: focusTask, reason: 'Last assigned stage failed.' };
}

function laneToneLabel(tone: LaneStateTone): string {
  switch (tone) {
    case 'active':
      return 'Active';
    case 'queued':
      return 'Queued';
    case 'blocked':
      return 'Blocked';
    case 'review':
      return 'Review';
    default:
      return 'Idle';
  }
}

export function ProvidersViewComponent({
  providers,
  agents,
  tasks,
  stats,
  totalAgents,
}: ProvidersViewProps) {
  const openTasks = tasks.filter((task) => task.status !== 'done');
  const queuedTasks = tasks.filter((task) => task.status === 'queued').length;
  const reviewTasks = tasks.filter((task) => task.status === 'review').length;
  const failedTasks = tasks.filter((task) => task.status === 'failed').length;
  const routedAgents = agents.filter((agent) => tasks.some((task) => task.assigneeId === agent.id && task.status !== 'done')).length;
  const routingConfidence = totalAgents > 0 ? Math.round((routedAgents / totalAgents) * 100) : 0;
  const laneLedger = agents
    .map((agent) => ({ agent, lane: deriveLaneState(agent, tasks) }))
    .sort((left, right) => {
      const toneOrder: Record<LaneStateTone, number> = { active: 0, blocked: 1, queued: 2, review: 3, idle: 4 };
      return toneOrder[left.lane.tone] - toneOrder[right.lane.tone];
    });

  return (
    <section className="workspace-stack" aria-labelledby="control-deck-title">
      <aside className="column column--side column--stacked">
        <section className="panel control-deck">
          <div className="task-wall__header">
            <div>
              <p className="eyebrow" id="control-deck-title">Control Deck</p>
              <p className="task-wall__copy">Provider load, lane assignment clarity, and runtime pressure in one place.</p>
            </div>
          </div>

          <div className="control-deck__metrics" role="list" aria-label="Control deck metrics">
            <article className="control-metric" role="listitem">
              <span>Routing confidence</span>
              <strong>{routingConfidence}%</strong>
            </article>
            <article className="control-metric" role="listitem">
              <span>Queued stages</span>
              <strong>{queuedTasks}</strong>
            </article>
            <article className="control-metric" role="listitem">
              <span>Review stages</span>
              <strong>{reviewTasks}</strong>
            </article>
            <article className="control-metric" role="listitem">
              <span>Failed stages</span>
              <strong>{failedTasks}</strong>
            </article>
          </div>

          <div className="control-deck__providers" role="list" aria-label="Provider load overview">
            {providers.map((provider) => {
              const providerAgents = agents.filter((agent) => agent.provider === provider.provider);
              const providerTasks = openTasks.filter((task) => task.provider === provider.provider);
              const activeCount = providerTasks.filter((task) => task.status === 'active').length;
              const queueCount = providerTasks.filter((task) => task.status === 'queued').length;
              const reviewCount = providerTasks.filter((task) => task.status === 'review').length;
              const loadPercent = openTasks.length > 0 ? Math.max(10, Math.round((providerTasks.length / openTasks.length) * 100)) : 10;
              return (
                <article key={provider.provider} className={`control-provider control-provider--${provider.state}`} role="listitem">
                  <div className="control-provider__header">
                    <div>
                      <p className="eyebrow">{provider.provider === 'copilot' ? 'Copilot' : 'Claude'}</p>
                      <strong>{provider.state === 'ready' ? 'Healthy' : 'Unavailable'}</strong>
                    </div>
                    <span className={`provider-chip__state control-provider__state control-provider__state--${provider.state}`}>{provider.state}</span>
                  </div>
                  <p>{provider.detail}</p>
                  <div className="control-provider__stats">
                    <span>{providerAgents.length} agents</span>
                    <span>{activeCount} active</span>
                    <span>{queueCount} queued</span>
                    <span>{reviewCount} review</span>
                  </div>
                  <div className="control-provider__bar" aria-hidden="true">
                    <div className="control-provider__fill" style={{ width: `${loadPercent}%` }} />
                  </div>
                </article>
              );
            })}
          </div>

          <div className="control-ledger">
            <div className="control-ledger__header">
              <div>
                <p className="eyebrow">Lane Assignment Ledger</p>
                <p className="task-wall__copy">See whether a lane is active, queued, blocked by dependencies, or truly idle.</p>
              </div>
            </div>
            <div className="control-ledger__list" role="list" aria-label="Lane assignment ledger">
              {laneLedger.map(({ agent, lane }) => (
                <article key={agent.id} className={`control-ledger__row control-ledger__row--${lane.tone}`} role="listitem">
                  <div className="control-ledger__agent">
                    <span className="control-ledger__sprite">
                      <AgentSprite personaId={agent.personaId} status={agent.status} size="card" />
                    </span>
                    <div>
                      <strong>{agent.name}</strong>
                      <p>{agent.id} · {agent.provider}</p>
                    </div>
                  </div>
                  <div className="control-ledger__task">
                    <strong>{lane.task?.title ?? 'No current stage'}</strong>
                    <p>{lane.reason}</p>
                  </div>
                  <span className={`control-ledger__badge control-ledger__badge--${lane.tone}`}>{laneToneLabel(lane.tone)}</span>
                </article>
              ))}
            </div>
          </div>

          <div className="provider-summary">
            <p className="eyebrow" id="agent-distribution-title">Fleet Summary</p>
            <dl className="facts" aria-labelledby="agent-distribution-title">
              <div><dt>Copilot agents</dt><dd>{stats.copilot}</dd></div>
              <div><dt>Claude agents</dt><dd>{stats.claude}</dd></div>
              <div><dt>Total agents</dt><dd>{totalAgents}</dd></div>
              <div><dt>Active tasks</dt><dd>{stats.active}</dd></div>
            </dl>
          </div>
        </section>
      </aside>
    </section>
  );
}
