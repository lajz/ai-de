/** DI token for the shared `@fde/llm` `Router` used by the read path. */
export const ROUTER = Symbol('ROUTER');

/**
 * DI token for the query-semantics embedding client (`inputType: 'query'`).
 * Kept distinct from the workers' stored-chunk client (`'document'`).
 */
export const QUERY_EMBEDDING_CLIENT = Symbol('QUERY_EMBEDDING_CLIENT');
