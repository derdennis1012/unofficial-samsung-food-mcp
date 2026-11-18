/**
 * Building blocks for MCP tool definitions: strict input validators and `defineTool`.
 */

import { z } from 'zod';

/** Opaque server-side IDs (recipes, lists, meals, ...): no whitespace or control characters. */
export const idSchema = (what = 'ID') =>
  z.string().trim().min(1).max(200).regex(/^[\w\-.:=+/]+$/, `${what} must be an ID as returned by the other tools`);

export const idList = (what = 'IDs', max = 100) => z.array(idSchema(what)).min(1).max(max);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** YYYY-MM-DD and a real calendar date. */
export const dateSchema = (describe = 'Date as YYYY-MM-DD') =>
  z
    .string()
    .regex(DATE_RE, 'must be YYYY-MM-DD')
    .refine((v) => {
      const d = new Date(`${v}T12:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
    }, 'not a real calendar date')
    .describe(describe);

export const MEAL_TIMES = ['breakfast', 'lunch', 'dinner', 'snack', 'togo'];
export const mealTimeSchema = () => z.enum(MEAL_TIMES).describe('breakfast | lunch | dinner | snack | togo');

export const LOCATIONS = ['fridge', 'freezer', 'pantry'];

/** Page size parameter with a hard cap, so responses stay small. */
export const limitSchema = (def = 20, max = 100) =>
  z.number().int().min(1).max(max).default(def).describe(`Maximum number of results, default ${def}, max ${max}`);

export const shortText = (describe, max = 500) => z.string().trim().min(1).max(max).describe(describe);

export const KINDS = {
  /** Reads data only. */
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  /** Creates or changes data without removing anything. */
  write: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  /** Same, but repeating it with the same arguments has no further effect. */
  update: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  /** Removes or overwrites data. */
  destructive: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
};

/**
 * @param {object} def
 * @param {string} def.name           tool name, snake_case, prefixed by its area
 * @param {string} def.description    what it does, what the IDs are, how to page for more
 * @param {'read'|'write'|'update'|'destructive'} def.kind  drives the MCP annotations
 * @param {import('zod').ZodObject} def.schema  strict input schema (unknown keys are rejected)

 * @param {boolean} [def.idempotent]  overrides the kind's default: false when repeating the call with the
 *        same arguments has a further effect (e.g. a tool that can create entries)
 * @param {boolean} [def.needsClient]  false for tools that never call the API (skips building the schema)
 * @param {object} [def.example]  valid sample arguments (placeholder IDs are fine); used by the offline validation tests
 * @param {(args:object, sf:import('../core/client.js').SamsungFood)=>Promise<any>} def.handler
 *        returns plain JSON-able data (objects/arrays); keep it concise
 */
export function defineTool({ name, description, kind, schema = z.object({}), handler, example = {}, idempotent, needsClient = true }) {
  if (!KINDS[kind]) throw new Error(`tool ${name}: unknown kind ${kind}`);
  return { name, description, annotations: { ...KINDS[kind], ...(idempotent === undefined ? {} : { idempotentHint: idempotent }) }, schema: schema.strict(), handler, example, needsClient };
}
