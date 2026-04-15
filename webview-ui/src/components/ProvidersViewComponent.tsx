import type { Provider } from '../../../src/shared/model/index.js';

export interface ProvidersViewProps {
  providers: Provider[];
  stats: {
    copilot: number;
    claude: number;
    active: number;
  };
  totalAgents: number;
}

export function ProvidersViewComponent({
  providers,
  stats,
  totalAgents,
}: ProvidersViewProps) {
  return (
    <section className="workspace-stack" aria-labelledby="providers-title">
      <aside className="column column--side column--stacked">
        <section className="panel">
          <div className="task-wall__header">
            <div>
              <p className="eyebrow" id="providers-title">Providers</p>
              <p className="task-wall__copy">Language model providers powering Pixel Squad agents.</p>
            </div>
          </div>
          <div className="provider-list" role="list" aria-label="Available providers">
            {providers.map((provider) => (
              <article
                key={provider.provider}
                className={`provider-chip provider-chip--${provider.state}`}
                role="listitem"
                aria-label={`${provider.provider} provider, status: ${provider.state}`}
              >
                <span className="provider-chip__icon" aria-hidden="true">
                  {provider.provider === 'copilot' ? '⚡' : '🧠'}
                </span>
                <div className="provider-chip__content">
                  <strong>{provider.provider}</strong>
                  <p>{provider.detail}</p>
                </div>
                <span className="provider-chip__state">{provider.state}</span>
              </article>
            ))}
          </div>
          <div className="provider-summary">
            <p className="eyebrow" id="agent-distribution-title">Agent Distribution</p>
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
