import { z } from 'zod';

/** Graph nodes are either canonical entities or derived facts. */
export const NODE_KINDS = ['entity', 'fact'] as const;
export const nodeKindSchema = z.enum(NODE_KINDS);
export type NodeKind = (typeof NODE_KINDS)[number];

/** Directed edge labels in the stakeholder ↔ decision ↔ work graph. */
export const PREDICATES = [
  'owns', // person → fact
  'accountable_for', // person → fact
  'informed_of', // person → fact
  'implemented_by', // decision → work_item
  'blocks', // work_item | risk → fact
  'supersedes', // decision → decision
  'relates_to', // generic
  'member_of', // person → organization
  'stakeholder_in', // person → engagement scope
] as const;
export const predicateSchema = z.enum(PREDICATES);
export type Predicate = (typeof PREDICATES)[number];
