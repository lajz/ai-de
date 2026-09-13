import { relativeTime } from '../lib/relative-time';
import type { ProvenanceSource } from '../lib/types';
import { safeHttpUrl } from '../lib/url';

/**
 * Compact, consistently-styled presentation of a `sources` row: connector +
 * kind, the channel/doc/meeting it came from and who authored it (when the
 * connector supplied those), a relative timestamp, and a permalink when one
 * exists. Shared by the fact provenance chain and the entity derivation panel
 * so "which meeting/thread, whose comment" reads the same everywhere a source
 * is cited.
 */
export function SourceBadge({ source }: { source: ProvenanceSource }) {
  const href = safeHttpUrl(source.urlPermalink);
  return (
    <span className="source-badge">
      <span className="source-badge-connector">{source.connector}</span>
      <span className="source-badge-kind">{source.kind}</span>
      {source.containerRef && <span className="source-badge-container">{source.containerRef}</span>}
      {source.authorRef && <span className="source-badge-author">{source.authorRef}</span>}
      <span className="source-badge-time">{relativeTime(source.occurredAt)}</span>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          permalink
        </a>
      ) : (
        <span className="no-permalink">(no permalink)</span>
      )}
    </span>
  );
}
