import type { ActivityEntry, ActivityCategory, AgentMessage, Room, SquadAgent } from '../../../src/shared/model/index.js';

export const ACTIVITY_FILTERS: Array<ActivityCategory | 'all'> = ['all', 'task', 'agent', 'agent-chat', 'provider', 'system'];

export interface ActivityFeedProps {
  filteredActivity: ActivityEntry[];
  activityFilter: ActivityCategory | 'all';
  setActivityFilter: (filter: ActivityCategory | 'all') => void;
  roomFeeds?: Record<string, AgentMessage[]>;
  agentsById?: Map<string, SquadAgent>;
  rooms?: Room[];
}

function formatActivityTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  }).format(timestamp);
}

function activityCategoryMeta(category: ActivityCategory): { icon: string; label: string } {
  switch (category) {
    case 'task':
      return { icon: '✓', label: 'Task' };
    case 'agent':
      return { icon: '◉', label: 'Agent' };
    case 'agent-chat':
      return { icon: '…', label: 'Chat' };
    case 'provider':
      return { icon: '⚙', label: 'Provider' };
    case 'system':
    default:
      return { icon: '•', label: 'System' };
  }
}

function latestRoomMessages(
  roomFeeds: Record<string, AgentMessage[]> | undefined,
  limit = 12,
): AgentMessage[] {
  if (!roomFeeds) return [];
  const all: AgentMessage[] = [];
  for (const messages of Object.values(roomFeeds)) {
    all.push(...messages);
  }
  return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
}

export function ActivityFeedComponent({
  filteredActivity,
  activityFilter,
  setActivityFilter,
  roomFeeds,
  agentsById,
  rooms,
}: ActivityFeedProps) {
  const conversations = latestRoomMessages(roomFeeds);
  const roomsById = new Map((rooms ?? []).map((room) => [room.id, room]));

  return (
    <section className="workspace-stack" aria-labelledby="activity-feed-title">
      <aside className="column column--side column--stacked">
        {conversations.length > 0 ? (
          <section className="panel activity-conversations" aria-label="Agent-to-agent conversations">
            <div className="task-wall__header">
              <div>
                <p className="eyebrow">Crew Chat</p>
                <p className="task-wall__copy">
                  Live messages between your agents — this is what your teammates are saying to each other while they work.
                </p>
              </div>
              <span className="hero-summary-pill">{conversations.length} recent</span>
            </div>
            <ul className="agent-chat-stream" role="list">
              {conversations.map((message) => {
                const fromAgent = agentsById?.get(message.fromAgentId);
                const toAgent = agentsById?.get(message.toAgentId);
                const room = roomsById.get(message.roomId);
                return (
                  <li key={message.id} className={`agent-chat-bubble agent-chat-bubble--${message.type}`} role="listitem">
                    <div className="agent-chat-bubble__head">
                      <strong>
                        {(fromAgent?.name ?? message.fromAgentId)} → {(toAgent?.name ?? message.toAgentId)}
                      </strong>
                      <span className={`agent-chat-bubble__type agent-chat-bubble__type--${message.type}`}>{message.type}</span>
                      <time dateTime={new Date(message.timestamp).toISOString()}>
                        {formatActivityTime(message.timestamp)}
                      </time>
                    </div>
                    <p className="agent-chat-bubble__body">{message.content}</p>
                    {room ? <span className="agent-chat-bubble__room">{room.name}</span> : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}

        <section className="panel">
          <div className="task-wall__header">
            <div>
              <p className="eyebrow" id="activity-feed-title">Activity Feed</p>
              <p className="task-wall__copy">
                Structured events are grouped by category so provider chatter and task flow are easier to scan.
              </p>
            </div>
            <label className="task-filter task-filter--compact">
              <span id="activity-filter-label">Filter</span>
              <select
                value={activityFilter}
                onChange={(event) => setActivityFilter(event.target.value as ActivityCategory | 'all')}
                aria-labelledby="activity-filter-label"
              >
                {ACTIVITY_FILTERS.map((filter) => (
                  <option key={filter} value={filter}>
                    {filter}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <ul className="activity-feed" role="list" aria-label="Activity events">
            {filteredActivity.length === 0 ? (
              <li className="activity-feed__empty" role="listitem">No activity matches the current filter.</li>
            ) : null}
            {filteredActivity.map((item) => {
              const meta = activityCategoryMeta(item.category);
              return (
                <li
                  key={item.id}
                  className={`activity-feed__item activity-feed__item--${item.category}`}
                  role="listitem"
                  aria-label={`${meta.label} event: ${item.message}`}
                >
                  <div className="activity-feed__meta">
                    <div className="activity-feed__meta-main">
                      <span className={`activity-badge activity-badge--${item.category}`} aria-hidden="true">
                        {meta.icon} {meta.label}
                      </span>
                      <span className="activity-feed__verb">{item.category.replace('-', ' ')}</span>
                    </div>
                    <time dateTime={new Date(item.timestamp).toISOString()}>{formatActivityTime(item.timestamp)}</time>
                  </div>
                  <p>{item.message}</p>
                </li>
              );
            })}
          </ul>
        </section>
      </aside>
    </section>
  );
}
