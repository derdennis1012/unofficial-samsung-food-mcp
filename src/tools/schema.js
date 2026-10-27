/** zod -> JSON Schema, covering the types the tool definitions use. */

export function describeZod(v) {
  const description = v._def?.description;
  const { node, def } = unwrapAll(v);
  const checks = node._def?.checks ?? [];
  let base;
  switch (node._def?.typeName) {
    case 'ZodString': {
      base = { type: 'string' };
      for (const c of checks) {
        if (c.kind === 'min') base.minLength = c.value;
        if (c.kind === 'max') base.maxLength = c.value;
        if (c.kind === 'regex') base.pattern = c.regex.source;
      }
      break;
    }
    case 'ZodNumber': {
      base = { type: checks.some((c) => c.kind === 'int') ? 'integer' : 'number' };
      for (const c of checks) {
        if (c.kind === 'min') base.minimum = c.value;
        if (c.kind === 'max') base.maximum = c.value;
      }
      break;
    }
    case 'ZodBoolean':
      base = { type: 'boolean' };
      break;
    case 'ZodArray': {
      base = { type: 'array', items: describeZod(node._def.type) };
      if (node._def.minLength) base.minItems = node._def.minLength.value;
      if (node._def.maxLength) base.maxItems = node._def.maxLength.value;
      break;
    }
    case 'ZodEnum':
      base = { type: 'string', enum: node._def.values };
      break;
    case 'ZodLiteral':
      base = { const: node._def.value };
      break;
    case 'ZodUnion':
      base = { anyOf: node._def.options.map(describeZod) };
      break;
    case 'ZodRecord':
      base = { type: 'object' };
      break;
    case 'ZodObject':
      base = toJsonSchema(node);
      break;
    default:
      base = {};
  }
  if (def !== undefined) base.default = def;
  const desc = description ?? unwrapAll(v).description;
  return desc ? { ...base, description: desc } : base;
}

/** Walks through optional/default/nullable/effects wrappers, keeping the first description. */
function unwrapAll(v) {
  let node = v;
  let def;
  let description = v._def?.description;
  for (;;) {
    const d = node._def;
    if (d?.description && !description) description = d.description;
    if (d?.typeName === 'ZodDefault') def = d.defaultValue();
    if (d?.typeName === 'ZodEffects') node = d.schema;
    else if (d?.innerType) node = d.innerType;
    else break;
  }
  return { node, def, description };
}

export function toJsonSchema(schema) {
  const shape = schema._def?.shape?.() ?? {};
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = describeZod(value);
    if (!value.isOptional()) required.push(key);
  }
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}
