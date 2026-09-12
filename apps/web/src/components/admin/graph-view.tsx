'use client';

import '@xyflow/react/dist/style.css';

import { Background, Controls, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { buildFlowGraph, graphFacets } from '../../lib/graph-layout';
import { entityTypeColor, entityTypeLine, factTypeColor, factTypeWash } from '../../lib/type-color';
import type { EngagementGraph, GraphNode } from '../../lib/types';

/** Tracks the OS/browser color scheme so canvas node fills stay theme-correct. */
function usePrefersDark(): boolean {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    setDark(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

export function GraphView({
  engagementId,
  graph,
  filters,
}: {
  engagementId: string;
  graph: EngagementGraph;
  filters: { entityType?: string; predicate?: string };
}) {
  const router = useRouter();
  const dark = usePrefersDark();
  const layout = useMemo(() => buildFlowGraph(graph, dark), [graph, dark]);
  const facets = useMemo(() => graphFacets(graph), [graph]);
  const factTypes = useMemo(
    () => [...new Set(graph.nodes.filter((n) => n.kind === 'fact').map((n) => n.type))].sort(),
    [graph],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
    setSelectedId(null);
  }, [layout, setNodes, setEdges]);

  const selected: GraphNode | undefined = graph.nodes.find((n) => n.id === selectedId);

  function setFilter(key: 'entityType' | 'predicate', value: string) {
    const qs = new URLSearchParams();
    const next = { ...filters, [key]: value || undefined };
    if (next.entityType) qs.set('entityType', next.entityType);
    if (next.predicate) qs.set('predicate', next.predicate);
    router.push(`/engagements/${engagementId}/admin/graph${qs.toString() ? `?${qs}` : ''}`);
  }

  return (
    <div className="graph-view">
      <div className="graph-filters">
        <label className="field-label">
          Entity type
          <select
            className="field-input"
            value={filters.entityType ?? ''}
            onChange={(e) => setFilter('entityType', e.target.value)}
          >
            <option value="">all</option>
            {facets.entityTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="field-label">
          Predicate
          <select
            className="field-input"
            value={filters.predicate ?? ''}
            onChange={(e) => setFilter('predicate', e.target.value)}
          >
            <option value="">all</option>
            {facets.predicates.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <span className="graph-count">
          <strong>{graph.nodes.length}</strong> nodes, <strong>{graph.edges.length}</strong> edges
        </span>
      </div>

      <div className="graph-legend">
        {facets.entityTypes.map((t) => (
          <span key={t} className="graph-legend-item">
            <span
              className="graph-legend-swatch"
              style={{
                background: entityTypeColor(t, dark),
                border: `1px solid ${entityTypeLine(t, dark)}`,
              }}
              aria-hidden="true"
            />
            {t}
          </span>
        ))}
        {factTypes.map((t) => (
          <span key={t} className="graph-legend-item">
            <span
              className="graph-legend-swatch"
              style={{
                background: factTypeWash(t, dark),
                border: `1px solid ${factTypeColor(t, dark)}`,
              }}
              aria-hidden="true"
            />
            {t}
          </span>
        ))}
      </div>

      {graph.truncated && (
        <p className="graph-truncated" role="alert">
          The graph hit the edge cap — some relationships are not shown. Narrow the filters.
        </p>
      )}

      <div className="graph-canvas" style={{ width: '100%', height: 520 }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={(_, node) => setSelectedId(node.id)}
          onPaneClick={() => setSelectedId(null)}
          fitView
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      {selected && (
        <aside className="graph-panel">
          <h2>{selected.label}</h2>
          <dl>
            <dt>kind</dt>
            <dd>{selected.kind}</dd>
            <dt>type</dt>
            <dd>{selected.type}</dd>
            {selected.status && (
              <>
                <dt>status</dt>
                <dd>{selected.status}</dd>
              </>
            )}
          </dl>
          {selected.externalRefs && selected.externalRefs.length > 0 && (
            <pre className="graph-refs">{JSON.stringify(selected.externalRefs, null, 2)}</pre>
          )}
          {selected.kind === 'fact' && (
            <Link href={`/engagements/${engagementId}/admin/lineage?factId=${selected.id}`}>
              Trace provenance
            </Link>
          )}
        </aside>
      )}
    </div>
  );
}
