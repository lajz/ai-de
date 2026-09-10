import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

import type { EngagementGraph, GraphNode } from './types';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 48;

/** A stable-ish hue per node type, so entity/fact families read as colour groups. */
export function nodeColor(node: GraphNode): string {
  if (node.kind === 'fact') return 'var(--graph-fact)';
  let hash = 0;
  for (const ch of node.type) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hash} 55% 82%)`;
}

/**
 * Lay the engagement graph out top-to-bottom with dagre and map it to React Flow
 * nodes/edges. Pure — no browser APIs — so it is unit-testable and can run in the
 * initial server payload.
 */
export function buildFlowGraph(graph: EngagementGraph): {
  nodes: Node[];
  edges: Edge[];
} {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 40, ranksep: 70 });
  g.setDefaultEdgeLabel(() => ({}));

  const known = new Set(graph.nodes.map((n) => n.id));
  for (const n of graph.nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of graph.edges) {
    if (known.has(e.fromId) && known.has(e.toId)) g.setEdge(e.fromId, e.toId);
  }

  dagre.layout(g);

  const nodes: Node[] = graph.nodes.map((n) => {
    const pos = g.node(n.id);
    return {
      id: n.id,
      position: { x: (pos?.x ?? 0) - NODE_WIDTH / 2, y: (pos?.y ?? 0) - NODE_HEIGHT / 2 },
      data: { label: n.label, graphNode: n },
      style: {
        width: NODE_WIDTH,
        background: nodeColor(n),
        border: '1px solid rgba(0,0,0,0.25)',
        borderRadius: 6,
        fontSize: 12,
        padding: 4,
      },
    };
  });

  const edges: Edge[] = graph.edges
    .filter((e) => known.has(e.fromId) && known.has(e.toId))
    .map((e) => ({
      id: e.id,
      source: e.fromId,
      target: e.toId,
      label: e.predicate,
      labelStyle: { fontSize: 10 },
    }));

  return { nodes, edges };
}

/** Distinct entity types + predicates present in a graph, for the filter selects. */
export function graphFacets(graph: EngagementGraph): {
  entityTypes: string[];
  predicates: string[];
} {
  const entityTypes = new Set<string>();
  for (const n of graph.nodes) if (n.kind === 'entity') entityTypes.add(n.type);
  const predicates = new Set(graph.edges.map((e) => e.predicate));
  return {
    entityTypes: [...entityTypes].sort(),
    predicates: [...predicates].sort(),
  };
}
