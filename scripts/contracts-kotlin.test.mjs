import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateKotlinDtos } from './contracts-kotlin.mjs';

const contract = () =>
  JSON.parse(readFileSync(new URL('../contracts/openapi.json', import.meta.url), 'utf8'));

test('fails when a consumed response introduces an unsupported union', () => {
  const document = contract();
  document.components.schemas.Product.properties.photoUrl = {
    oneOf: [{ type: 'string' }, { type: 'object' }],
  };
  assert.throws(() => generateKotlinDtos(document), /Product.photoUrl: oneOf/);
});

test('fails when a required field has no declared property', () => {
  const document = contract();
  delete document.components.schemas.Product.properties.active;
  assert.throws(() => generateKotlinDtos(document), /required property missing/);
});

test('fails on external or missing references instead of inventing a type', () => {
  const external = contract();
  external.components.schemas.InventoryDetail.properties.product = {
    $ref: 'https://example.invalid/Product',
  };
  assert.throws(() => generateKotlinDtos(external), /external reference/);
  const missing = contract();
  delete missing.components.schemas.Product;
  assert.throws(() => generateKotlinDtos(missing), /Product: expected schema object/);
});

test('fails on integer formats that cannot be represented safely', () => {
  const document = contract();
  document.components.schemas.InventoryDetail.properties.totalQuantity.format = 'uint64';
  assert.throws(() => generateKotlinDtos(document), /integer format uint64/);
});

test('fails on recursive DTO graphs before generating uncompilable code', () => {
  const document = contract();
  document.components.schemas.Product.properties.related = { $ref: '#/components/schemas/Product' };
  assert.throws(() => generateKotlinDtos(document), /recursive DTOs/);
});
