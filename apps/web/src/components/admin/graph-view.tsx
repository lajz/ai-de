'use client';

import '@xyflow/react/dist/style.css';

import { Background, Controls, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { buildFlowGraph, graphFacets } from '../../lib/graph-layout';
import type { EngagementGraph, GraphNode } from '../../lib/types';

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
  const layout = useMemo(() => buildFlowGraph(graph), [graph]);
  const facets = useMemo(() => graphFacets(graph), [graph]);

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
        <label>
          Entity type
          <select
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
        <label>
          Predicate
          <select
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
          {graph.nodes.length} nodes · {graph.edges.length} edges
        </span>
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
              Trace provenance →
            </Link>
          )}
        </aside>
      )}
    </div>
  );
}
