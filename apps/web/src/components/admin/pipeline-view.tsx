import { relativeTime } from '../../lib/relative-time';
import type { PipelineStatus } from '../../lib/types';

function usd(n: number | null): string {
  return n != null ? `$${n.toFixed(4)}` : '—';
}

/** Rollup stat cards + sync-state and recent-extraction-run tables. */
export function PipelineView({ pipeline }: { pipeline: PipelineStatus }) {
  const { rollups, syncStates, recentExtractionRuns } = pipeline;
  const byConnector = Object.entries(rollups.sourcesByConnector);

  return (
    <div className="pipeline">
      <ul className="stat-cards">
        <li>
          <span className="stat-value">{rollups.totalFacts}</span>
          <span className="stat-label">facts</span>
        </li>
        <li>
          <span className="stat-value">{rollups.totalEmbeddings}</span>
          <span className="stat-label">embeddings</span>
        </li>
        <li>
          <span className="stat-value">{usd(rollups.totalCostUsd)}</span>
          <span className="stat-label">extraction cost</span>
        </li>
        <li>
          <span className="stat-value">{byConnector.reduce((s, [, n]) => s + n, 0)}</span>
          <span className="stat-label">sources</span>
        </li>
      </ul>

      {byConnector.length > 0 && (
        <p className="sources-by-connector">
          {byConnector.map(([c, n]) => `${c}: ${n}`).join(' · ')}
        </p>
      )}

      <h2>Sync state</h2>
      {syncStates.length === 0 ? (
        <p>No connector has synced yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Connector</th>
                <th>Status</th>
                <th>Last run</th>
                <th>Cursor</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {syncStates.map((s) => (
                <tr key={s.connector}>
                  <td>{s.connector}</td>
                  <td>
                    <span className={`sync-badge sync-${s.status}`}>{s.status}</span>
                  </td>
                  <td>{relativeTime(s.lastRunAt) ?? '—'}</td>
                  <td>{s.cursorPresent ? 'set' : '—'}</td>
                  <td>{relativeTime(s.updatedAt) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Recent extraction runs</h2>
      {recentExtractionRuns.length === 0 ? (
        <p>No extraction runs recorded.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th>Prompt</th>
                <th>Cost</th>
                <th>Sources</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {recentExtractionRuns.map((r, i) => (
                <tr key={`${r.createdAt}-${i}`}>
                  <td>{r.model}</td>
                  <td>{r.promptVersion}</td>
                  <td>{usd(r.costUsd)}</td>
                  <td>{r.inputSourceCount}</td>
                  <td>{relativeTime(r.createdAt) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
