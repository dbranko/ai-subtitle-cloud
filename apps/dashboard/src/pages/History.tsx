import { useEffect, useState } from 'react';
import { api, withToken, type Job, type JobQuery } from '../api';
import { errorMessage, formatCost, formatTime, stateLabel } from '../format';
import { jobHref } from '../router';

const PAGE_SIZE = 20;
type Filter = 'all' | 'completed' | 'failed' | 'cancelled';

/**
 * Finished translations, newest first, with a filter and pages. `refreshKey`
 * changes when a job finishes, so the list follows live without polling.
 */
export function History({ refreshKey }: { refreshKey: string }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const [data, setData] = useState<{ jobs: Job[]; total: number } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stale = false;
    const query: JobQuery = { scope: 'finished', limit: PAGE_SIZE, offset: page * PAGE_SIZE };
    if (filter !== 'all') query.status = filter;
    api
      .jobs(query)
      .then((r) => {
        if (stale) return;
        setData(r);
        setError('');
      })
      .catch((err: unknown) => !stale && setError(errorMessage(err, 'Could not load history.')));
    return () => {
      stale = true;
    };
  }, [filter, page, refreshKey]);

  const pages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <section className="card" data-testid="history">
      <div className="card-head">
        <h2>History</h2>
        <label className="inline">
          Show{' '}
          <select
            value={filter}
            data-testid="history-filter"
            onChange={(e) => {
              setFilter(e.target.value as Filter);
              setPage(0);
            }}
          >
            <option value="all">All finished</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {data && data.jobs.length === 0 && <p className="muted">No translations here.</p>}
      {data && data.jobs.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Language</th>
                <th>Result</th>
                <th>Finished</th>
                <th>Model</th>
                <th>Cost</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((job) => (
                <tr key={job.id} data-testid="history-row" data-state={job.state}>
                  <td>
                    <a href={jobHref(job.id)}>{job.mediaTitle}</a>
                    {job.origin === 'stremio' && <span className="muted small"> · Stremio</span>}
                  </td>
                  <td>
                    {job.sourceLanguage ?? 'auto'} → {job.targetLanguage}
                  </td>
                  <td>
                    <span className={`state state-${job.state}`}>{stateLabel(job.state)}</span>
                    {job.error && <div className="muted small">{job.error.message}</div>}
                  </td>
                  <td className="small">{formatTime(job.completedAt ?? job.updatedAt)}</td>
                  <td className="small">
                    {(job.usedModels.length > 0
                      ? job.usedModels
                      : [{ provider: job.provider, model: job.model }]
                    )
                      .map((m) => `${m.provider} / ${m.model}`)
                      .join(', ')}
                  </td>
                  <td className="small">{formatCost(job.costUsd)}</td>
                  <td>
                    {job.hasOutput && (
                      <a href={withToken(`/api/v1/jobs/${job.id}/download`)}>Download</a>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > PAGE_SIZE && (
        <div className="pager">
          <button disabled={page === 0} onClick={() => setPage(page - 1)} data-testid="prev-page">
            ← Newer
          </button>
          <span className="muted small" data-testid="page-info">
            Page {page + 1} of {pages} · {data.total} translations
          </span>
          <button
            disabled={page + 1 >= pages}
            onClick={() => setPage(page + 1)}
            data-testid="next-page"
          >
            Older →
          </button>
        </div>
      )}
      {data && data.total <= PAGE_SIZE && data.total > 0 && (
        <p className="muted small" data-testid="page-info">
          {data.total} translation{data.total === 1 ? '' : 's'}
        </p>
      )}
    </section>
  );
}
