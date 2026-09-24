/** Small, deliberately strict OpenAPI 3.0 DTO generator; see ADR 0002. */
const roots = [
  'MobileSession',
  'Product',
  'InventoryDetail',
  'PageExpiryItem',
  'ExpirySummary',
  'PageInventoryItem',
  'PageHistoryItem',
  'PageCountSession',
  'PushConfig',
];
const reserved = new Set([
  'as',
  'break',
  'class',
  'continue',
  'do',
  'else',
  'false',
  'for',
  'fun',
  'if',
  'in',
  'interface',
  'is',
  'null',
  'object',
  'package',
  'return',
  'super',
  'this',
  'throw',
  'true',
  'try',
  'typealias',
  'typeof',
  'val',
  'var',
  'when',
  'while',
]);
const identifier = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !reserved.has(name);
const annotations = ['title', 'description', 'example', 'deprecated', 'readOnly', 'writeOnly'];

export function generateKotlinDtos(document) {
  if (!/^3\.0\./.test(document.openapi)) throw new Error('Kotlin DTOs require OpenAPI 3.0.');
  const schemas = document.components?.schemas;
  if (!schemas) throw new Error('Missing components.schemas.');
  const classes = new Map();
  const enums = new Map();
  const visiting = new Set();
  const fail = (path, detail) => {
    throw new Error(`Unsupported Kotlin schema at ${path}: ${detail}`);
  };
  const keys = (schema, allowed, path) => {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema))
      fail(path, 'expected schema object');
    for (const key of Object.keys(schema))
      if (![...allowed, ...annotations].includes(key)) fail(path, key);
  };
  const nameOf = (name) => {
    if (!identifier(name)) fail(name, 'unsafe identifier');
    return `Api${name}`;
  };
  function typeOf(schema, path, enumName) {
    if (schema.$ref) {
      keys(schema, ['$ref', 'nullable'], path);
      if (!schema.$ref.startsWith('#/components/schemas/')) fail(path, 'external reference');
      const name = schema.$ref.slice('#/components/schemas/'.length);
      visit(name);
      return nameOf(name) + (schema.nullable ? '?' : '');
    }
    keys(
      schema,
      [
        'type',
        'format',
        'nullable',
        'enum',
        'items',
        'minLength',
        'maxLength',
        'pattern',
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'minItems',
        'maxItems',
        'uniqueItems',
        'multipleOf',
      ],
      path,
    );
    let type;
    if (schema.enum) {
      if (
        schema.type !== 'string' ||
        !Array.isArray(schema.enum) ||
        !schema.enum.length ||
        schema.enum.some(
          (entry) => typeof entry !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(entry),
        ) ||
        new Set(schema.enum).size !== schema.enum.length
      )
        fail(path, 'only distinct uppercase string enums are supported');
      if (enums.has(enumName) || classes.has(enumName))
        fail(path, `duplicate generated type ${enumName}`);
      enums.set(enumName, schema.enum);
      type = enumName;
    } else if (schema.type === 'string') {
      if (
        schema.format &&
        !['uuid', 'date', 'date-time', 'uri', 'email', 'password'].includes(schema.format)
      )
        fail(path, `string format ${schema.format}`);
      type = 'String';
    } else if (schema.type === 'integer') {
      if (schema.format && !['int32', 'int64'].includes(schema.format))
        fail(path, `integer format ${schema.format}`);
      type = schema.format === 'int64' ? 'Long' : 'Int';
    } else if (schema.type === 'number') {
      if (schema.format && !['float', 'double'].includes(schema.format))
        fail(path, `number format ${schema.format}`);
      type = 'Double';
    } else if (schema.type === 'boolean') type = 'Boolean';
    else if (schema.type === 'array')
      type = `List<${typeOf(schema.items, `${path}.items`, `${enumName}Item`)}>`;
    else fail(path, `type ${schema.type}; use a named object schema`);
    return type + (schema.nullable ? '?' : '');
  }
  function visit(name) {
    const generated = nameOf(name);
    if (classes.has(generated)) return;
    if (visiting.has(name)) fail(name, 'recursive DTOs are not supported');
    const schema = schemas[name];
    keys(schema, ['type', 'properties', 'required', 'additionalProperties'], name);
    if (
      schema.type !== 'object' ||
      !schema.properties ||
      (schema.additionalProperties && schema.additionalProperties !== false)
    )
      fail(name, 'expected named object with declared properties');
    if (enums.has(generated)) fail(name, `duplicate generated type ${generated}`);
    const required = schema.required ?? [];
    if (
      !Array.isArray(required) ||
      required.some((property) => !Object.hasOwn(schema.properties, property))
    )
      fail(name, 'required property missing from properties');
    visiting.add(name);
    const fields = Object.entries(schema.properties).map(([property, value]) => {
      if (!identifier(property)) fail(`${name}.${property}`, 'unsafe property identifier');
      let type = typeOf(
        value,
        `${name}.${property}`,
        `${generated}${property[0].toUpperCase()}${property.slice(1)}`,
      );
      const optional = !required.includes(property);
      if (optional && !type.endsWith('?')) type += '?';
      return `    val ${property}: ${type}${optional ? ' = null' : ''},`;
    });
    if (!fields.length) fail(name, 'empty object');
    classes.set(
      generated,
      `@Serializable\ninternal data class ${generated}(\n${fields.join('\n')}\n)`,
    );
    visiting.delete(name);
  }
  roots.forEach(visit);
  const declarations = [
    ...classes,
    ...Array.from(enums, ([name, entries]) => [
      name,
      `@Serializable\ninternal enum class ${name} {\n${entries.map((entry) => `    ${entry},`).join('\n')}\n}`,
    ]),
  ];
  declarations.sort(([a], [b]) => a.localeCompare(b, 'en'));
  return (
    '// Generated from contracts/openapi.json. Run pnpm contracts:generate. Do not edit.\npackage br.com.estoque.core.network.generated\n\nimport kotlinx.serialization.Serializable\n\n' +
    declarations.map(([, source]) => source).join('\n\n') +
    '\n'
  );
}
