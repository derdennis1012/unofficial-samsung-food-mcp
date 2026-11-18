/** zod -> JSON Schema (draft 2020-12) for tool inputs: MCP tools/list, HTTP /v1/tools and OpenAPI. */

import { z } from 'zod';

/**
 * Input-side JSON Schema of a tool's zod object: fields with a default are optional,
 * strict objects get `additionalProperties: false`.
 * The top-level `$schema` is dropped (MCP and OpenAPI 3.1 both default to draft 2020-12), and so are
 * the safe-integer bounds zod adds to every `.int()`, which carry no information for a client.
 */
export function toJsonSchema(schema) {
  const { $schema: _dialect, ...js } = z.toJSONSchema(schema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
    override: ({ jsonSchema: s }) => {
      if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
      if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum;
    },
  });
  return js;
}
