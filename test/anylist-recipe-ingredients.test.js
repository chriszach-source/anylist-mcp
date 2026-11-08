import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import AnyListClient from '../src/anylist-client.js';

// listIngredients and editIngredients over anylist-js's real Recipe objects,
// with the save captured and decoded, so the test checks what AnyList would
// receive.
const require = createRequire(new URL('../anylist-js/lib/index.js', import.meta.url));
const protobuf = require('protobufjs');
const definitions = require('./definitions.json');
const Recipe = require('./recipe.js');
const pb = protobuf.newBuilder({}).import(definitions).build('pcov.proto');

function decodeSavedRecipes(form) {
  const body = form.getBuffer();
  const start = body.indexOf('\r\n\r\n') + 4;
  const end = body.lastIndexOf(Buffer.from(`\r\n--${form.getBoundary()}--`));
  return pb.PBRecipeOperationList.decode(body.subarray(start, end)).operations.map(o => o.recipe);
}

describe('AnyListClient ingredient lines', () => {
  let client;
  let posts;

  beforeEach(() => {
    posts = [];
    const http = { post: async (path, { body }) => { posts.push({ path, body }); } };
    const context = { client: http, protobuf: pb, uid: 'user-1', recipeDataId: 'rd-1' };
    const recipes = [
      new Recipe({
        identifier: 'r-salsa', name: 'Salsa', creationTimestamp: Date.parse('2026-11-01T12:00:00') / 1000,
        nutritionalInfo: 'Calories: 20', photoUrls: ['https://example.com/salsa.jpg'], servings: '4',
        ingredients: [
          { identifier: 'i-1', name: 'Tomatoes', quantity: '500 g', note: 'diced', rawIngredient: '500 g Tomatoes, diced' },
          { identifier: 'i-2', name: 'Seasoning', isHeading: true, rawIngredient: 'Seasoning' },
          { identifier: 'i-3', name: '1 tsp kosher salt', rawIngredient: '1 tsp kosher salt' },
        ],
      }, context),
      new Recipe({
        identifier: 'r-old', name: 'Old Soup', creationTimestamp: Date.parse('2025-01-01T12:00:00') / 1000,
        ingredients: [{ identifier: 'i-9', name: 'Kosher salt', quantity: '1 tsp', rawIngredient: '1 tsp Kosher salt' }],
      }, context),
    ];
    client = new AnyListClient();
    client.client = { getRecipes: async () => recipes };
  });

  it('lists every line, headings included, with line numbers', async () => {
    const rows = await client.listIngredients();
    assert.deepEqual(rows.map(r => [r.recipe, r.line, r.isHeading, r.quantity, r.name, r.note]), [
      ['Salsa', 1, false, '500 g', 'Tomatoes', 'diced'],
      ['Salsa', 2, true, '', 'Seasoning', ''],
      ['Salsa', 3, false, '', '1 tsp kosher salt', ''],
      ['Old Soup', 1, false, '1 tsp', 'Kosher salt', ''],
    ]);
  });

  it('filters by text, recipe, and creation date', async () => {
    assert.deepEqual((await client.listIngredients({ search: 'SALT' })).map(r => r.recipe), ['Salsa', 'Old Soup']);
    assert.deepEqual((await client.listIngredients({ recipeName: 'old soup' })).map(r => r.name), ['Kosher salt']);
    assert.deepEqual((await client.listIngredients({ since: '2026-10-15' })).map(r => r.recipe), ['Salsa', 'Salsa', 'Salsa']);
    await assert.rejects(client.listIngredients({ since: 'soon' }), /Invalid date/);
  });

  it('edits lines in place with one save per recipe, keeping ids, order, and other fields', async () => {
    const results = await client.editIngredients([
      { recipe: 'Salsa', line: 3, currentName: '1 tsp kosher salt', quantity: '6 g', name: 'kosher salt', note: 'about 1 tsp' },
      { recipe: 'salsa', line: 1, currentName: 'tomatoes', note: '' },
    ]);
    assert.deepEqual(results.map(r => r.outcome), ['updated', 'updated']);
    assert.equal(posts.length, 1);
    const [saved] = decodeSavedRecipes(posts[0].body);
    assert.equal(saved.identifier, 'r-salsa');
    assert.deepEqual(saved.ingredients.map(i => [i.identifier, i.quantity, i.name, i.note, Boolean(i.isHeading), i.rawIngredient]), [
      ['i-1', '500 g', 'Tomatoes', null, false, '500 g Tomatoes'],
      ['i-2', null, 'Seasoning', null, true, 'Seasoning'],
      ['i-3', '6 g', 'kosher salt', 'about 1 tsp', false, '6 g kosher salt, about 1 tsp'],
    ]);
    assert.equal(saved.nutritionalInfo, 'Calories: 20');
    assert.deepEqual(saved.photoUrls, ['https://example.com/salsa.jpg']);
    assert.equal(saved.servings, '4');
  });

  it('skips and reports edits that don\'t match, saving nothing for them', async () => {
    const results = await client.editIngredients([
      { recipe: 'Salsa', line: 1, currentName: 'Onion', note: 'x' },
      { recipe: 'Salsa', line: 9, currentName: 'Tomatoes', note: 'x' },
      { recipe: 'Nachos', line: 1, currentName: 'Chips', note: 'x' },
      { recipe: 'Salsa', line: 1, currentName: 'Tomatoes', name: ' ' },
    ]);
    assert.deepEqual(results.map(r => r.outcome), [
      'line 1 is now "Tomatoes", not "Onion"; skipped',
      'no line 9 (the recipe has 3)',
      'recipe not found',
      'a line needs a name; skipped',
    ]);
    assert.equal(posts.length, 0);
  });

  it('reads headings back as headings (anylist-js\'s Ingredient has no isHeading getter)', async () => {
    const details = await client.getRecipeDetails('Salsa');
    assert.deepEqual(details.ingredients.map(i => i.isHeading), [false, true, false]);
  });
});
