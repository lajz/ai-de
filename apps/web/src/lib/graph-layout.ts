import dagre from '@dagrejs/dagre';
import type { Edge, Node } from '@xyflow/react';

import { entityTypeColor, entityTypeLine, factTypeColor, factTypeWash } from './type-color';
import type { EngagementGraph, GraphNode } from './types';

export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 48;

/** Node fill, theme-aware — the same per-type palette as the fact list/legend. */
export function nodeColor(node: GraphNode, dark = false): string {
  return node.kind === 'fact' ? factTypeWash(node.type, dark) : entityTypeColor(node.type, dark);
}

/** Node border, theme-aware — the saturated line tone matching `nodeColor`'s fill. */
export function nodeBorderColor(node: GraphNode, dark = false): string {
  return node.kind === 'fact' ? factTypeColor(node.type, dark) : entityTypeLine(node.type, dark);
}

/**
 * Lay the engagement graph out top-to-bottom with dagre and map it to React Flow
 * nodes/edges. Pure — no browser APIs — so it is unit-testable and can run in the
 * initial server payload.
 */
export function buildFlowGraph(
  graph: EngagementGraph,
  dark = false,
): {
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
    const isFact = n.kind === 'fact';
    return {
      id: n.id,
      position: { x: (pos?.x ?? 0) - NODE_WIDTH / 2, y: (pos?.y ?? 0) - NODE_HEIGHT / 2 },
      data: { label: n.label, graphNode: n },
      style: {
        width: NODE_WIDTH,
        background: nodeColor(n, dark),
        color: dark ? '#e7e9ee' : '#171b21',
        borderLeft: `3px solid ${nodeBorderColor(n, dark)}`,
        borderTop: `1px solid ${nodeBorderColor(n, dark)}`,
        borderRight: `1px solid ${nodeBorderColor(n, dark)}`,
        borderBottom: `1px solid ${nodeBorderColor(n, dark)}`,
        borderRadius: 4,
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        fontWeight: isFact ? 600 : 400,
        padding: '6px 8px',
      },
    };
  });

  const edgeStroke = dark ? '#8a93a3' : '#5b6472';
  const edges: Edge[] = graph.edges
    .filter((e) => known.has(e.fromId) && known.has(e.toId))
    .map((e) => ({
      id: e.id,
      source: e.fromId,
      target: e.toId,
      label: e.predicate,
      style: { stroke: edgeStroke },
      labelStyle: { fontSize: 10, fontFamily: 'var(--font-mono)', fill: edgeStroke },
      labelBgStyle: { fill: dark ? '#181c24' : '#ffffff' },
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
