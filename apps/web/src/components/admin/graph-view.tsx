'use client';

import '@xyflow/react/dist/style.css';

import { Background, Controls, ReactFlow, useEdgesState, useNodesState } from '@xyflow/react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import {
  buildAdjacency,
  buildFlowGraph,
  expandNode,
  filterGraph,
  graphFacets,
  pickSeedNodes,
  visibleSubgraph,
} from '../../lib/graph-layout';
import { entityTypeColor, entityTypeLine, factTypeColor, factTypeWash } from '../../lib/type-color';
import type { EngagementGraph, GraphNode } from '../../lib/types';
import { EntityProvenancePanel } from './entity-provenance-panel';

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
}: {
  engagementId: string;
  graph: EngagementGraph;
}) {
  const dark = usePrefersDark();
  const [entityType, setEntityType] = useState('');
  const [predicate, setPredicate] = useState('');
  // Facets always derive from the unfiltered `graph`, never from `filtered`
  // below — that's the fix for the filters narrowing each other's own
  // choices (see `filterGraph`'s doc comment).
  const facets = useMemo(() => graphFacets(graph), [graph]);
  const factTypes = useMemo(
    () => [...new Set(graph.nodes.filter((n) => n.kind === 'fact').map((n) => n.type))].sort(),
    [graph],
  );

  const filtered = useMemo(
    () =>
      filterGraph(graph, {
        entityType: entityType || undefined,
        predicate: predicate || undefined,
      }),
    [graph, entityType, predicate],
  );
  const adjacency = useMemo(() => buildAdjacency(filtered), [filtered]);
  const [visible, setVisible] = useState<Set<string>>(() => new Set(pickSeedNodes(filtered)));
  const sub = useMemo(() => visibleSubgraph(filtered, visible), [filtered, visible]);
  const layout = useMemo(() => buildFlowGraph(sub, dark), [sub, dark]);

  const [nodes, setNodes, onNodesChange] = useNodesState(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(layout.edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [layout, setNodes, setEdges]);

  // A new `filtered` graph (the entityType/predicate filters changed, or the
  // page got a new `graph`) starts over from its own seed nodes.
  useEffect(() => {
    setVisible(new Set(pickSeedNodes(filtered)));
    setSelectedId(null);
  }, [filtered]);

  const selected: GraphNode | undefined = graph.nodes.find((n) => n.id === selectedId);

  return (
    <div className="graph-view">
      <div className="graph-filters">
        <label className="field-label">
          Entity type
          <select
            className="field-input"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
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
            value={predicate}
            onChange={(e) => setPredicate(e.target.value)}
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
          <strong>{sub.nodes.length}</strong> of <strong>{filtered.nodes.length}</strong> nodes
          shown · <strong>{sub.edges.length}</strong> edges
        </span>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => {
            setVisible(new Set(pickSeedNodes(filtered)));
            setSelectedId(null);
          }}
        >
          Reset view
        </button>
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
          The graph hit a size cap — some nodes or relationships are not shown. Narrow the filters.
        </p>
      )}

      <div className="graph-body">
        <div className="graph-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={(_, node) => {
              setSelectedId(node.id);
              setVisible((prev) => expandNode(adjacency, prev, node.id));
            }}
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
            {selected.kind === 'entity' && (
              <EntityProvenancePanel
                engagementId={engagementId}
                entityId={selected.id}
                entityLabel={selected.label}
              />
            )}
            {selected.kind === 'fact' && (
              <Link href={`/engagements/${engagementId}/lineage?factId=${selected.id}`}>
                Trace provenance
              </Link>
            )}
            {selected.externalRefs && selected.externalRefs.length > 0 && (
              <details className="graph-refs-details">
                <summary>Raw external refs</summary>
                <pre className="graph-refs">{JSON.stringify(selected.externalRefs, null, 2)}</pre>
              </details>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}
