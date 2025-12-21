import fs from 'node:fs';

const inputPath = 'schemas/blockkit-response.schema.json';
const outputPath = 'schemas/blockkit-response.openai.schema.json';

const root = JSON.parse(fs.readFileSync(inputPath, 'utf8'));

const UNSUPPORTED_KEYS = new Set([
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'patternProperties',
  '$id',
  'minLength',
  'maxLength',
]);

const clone = (value) => JSON.parse(JSON.stringify(value));

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(target, source) {
  if (!isPlainObject(target) || !isPlainObject(source)) return clone(source);
  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = clone(value);
    }
  }
  return out;
}

function resolveRef(ref) {
  if (!ref.startsWith('#/')) return null;
  const parts = ref.slice(2).split('/');
  let current = root;
  for (const part of parts) {
    if (!isPlainObject(current)) return null;
    current = current[part];
  }
  return isPlainObject(current) || Array.isArray(current) ? current : null;
}

function isRequiredOnlySchema(schema) {
  if (!isPlainObject(schema)) return false;
  const keys = Object.keys(schema);
  if (keys.length === 0) return false;
  return keys.every((k) => k === 'required');
}

function getRequiredSets(list) {
  if (!Array.isArray(list) || list.length === 0) return [];
  if (!list.every(isRequiredOnlySchema)) return [];
  return list
    .map((entry) => entry.required)
    .filter((value) => Array.isArray(value) && value.length > 0);
}

function choosePreferredRequired(requiredSets) {
  if (requiredSets.length === 0) return null;
  const withText = requiredSets.find((set) => set.includes('text'));
  return withText ?? requiredSets[0];
}

function transform(node) {
  if (Array.isArray(node)) {
    return node.map(transform);
  }
  if (!isPlainObject(node)) {
    return node;
  }

  let obj = clone(node);
  const wasRequiredOnly = isRequiredOnlySchema(obj);

  for (const key of Object.keys(obj)) {
    if (UNSUPPORTED_KEYS.has(key)) {
      delete obj[key];
    }
  }

  if (wasRequiredOnly) {
    return obj;
  }

  if (obj.allOf) {
    let merged = {};
    for (const entry of obj.allOf) {
      let resolved = entry;
      if (isPlainObject(entry) && typeof entry.$ref === 'string') {
        const refValue = resolveRef(entry.$ref);
        if (refValue) {
          resolved = refValue;
        }
      }
      merged = deepMerge(merged, transform(resolved));
    }
    delete obj.allOf;
    obj = deepMerge(merged, obj);
  }

  if (obj.const !== undefined) {
    obj.enum = [obj.const];
    delete obj.const;
  }

  if (obj.oneOf) {
    obj.anyOf = obj.oneOf;
    delete obj.oneOf;
  }

  if (obj.properties) {
    const nextProps = {};
    for (const [key, value] of Object.entries(obj.properties)) {
      nextProps[key] = transform(value);
    }
    obj.properties = nextProps;
  }

  if (obj.items) {
    obj.items = transform(obj.items);
  }

  if (obj.anyOf) {
    obj.anyOf = obj.anyOf.map(transform);
  }

  if (obj.$defs) {
    const nextDefs = {};
    for (const [key, value] of Object.entries(obj.$defs)) {
      nextDefs[key] = transform(value);
    }
    obj.$defs = nextDefs;
  }

  const requiredSets = getRequiredSets(obj.anyOf);
  if (obj.properties) {
    let effectiveRequired = Array.isArray(obj.required) ? [...obj.required] : null;
    const preferred = choosePreferredRequired(requiredSets);
    if (preferred) {
      effectiveRequired = Array.from(new Set([...(effectiveRequired ?? []), ...preferred]));
    }
    if (effectiveRequired) {
      const nextProps = {};
      for (const key of effectiveRequired) {
        if (Object.prototype.hasOwnProperty.call(obj.properties, key)) {
          nextProps[key] = obj.properties[key];
        }
      }
      obj.properties = nextProps;
    }
  }

  if (requiredSets.length > 0) {
    delete obj.anyOf;
  }

  const hasObjectHints = obj.type === 'object' || obj.properties || obj.required || obj.additionalProperties;
  if (hasObjectHints) {
    obj.type = 'object';
    if (!obj.properties) {
      obj.properties = {};
    }
    const propKeys = Object.keys(obj.properties ?? {});
    obj.required = propKeys;
    obj.additionalProperties = false;
  }

  return obj;
}

const transformed = transform(root);
transformed.$schema = 'https://json-schema.org/draft/2020-12/schema';

fs.writeFileSync(outputPath, `${JSON.stringify(transformed, null, 2)}\n`, 'utf8');
console.log(`Wrote ${outputPath}`);
