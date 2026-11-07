import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import AnyListClient from '../src/anylist-client.js';

// Checks the operations AnyListClient sends for stores, categories, and
// prices, encoded with anylist-js's real protobuf definitions and decoded
// back. The list is built the way anylist-js builds it from user-data/get,
// with the network call captured.
const require = createRequire(new URL('../anylist-js/lib/index.js', import.meta.url));
const protobuf = require('protobufjs');
const definitions = require('./definitions.json');
const List = require('./list.js');
const pb = protobuf.newBuilder({}).import(definitions).build('pcov.proto');

function decodeSentOperations(form) {
  const body = form.getBuffer();
  const start = body.indexOf('\r\n\r\n') + 4;
  const end = body.lastIndexOf(Buffer.from(`\r\n--${form.getBoundary()}--`));
  return pb.PBListOperationList.decode(body.subarray(start, end)).operations;
}

// Round-trip through the wire format so the snapshot holds decoded messages,
// as it does after login.
const decoded = (type, fields) => pb[type].decode(new pb[type](fields).toBuffer());

const GROUP_1_ASSIGNMENT_ID = 'cf2b8e377ce55e4180dcc7898dba32b6'; // Python uuid5(namespace, 'group-1').hex

describe('AnyListClient shopping operations', () => {
  let client;
  let posts;

  beforeEach(() => {
    posts = [];
    const http = { post: async (path, { body }) => { posts.push({ path, body }); } };
    const rawList = decoded('ShoppingList', {
      identifier: 'list-1',
      name: 'Grocery List',
      items: [
        {
          identifier: 'item-milk', listId: 'list-1', name: 'Milk', details: '2%', checked: false,
          categoryMatchId: 'other', category: 'other',
          categoryAssignments: [
            { identifier: GROUP_1_ASSIGNMENT_ID, categoryGroupId: 'group-1', categoryId: 'cat-other' },
            { identifier: 'assign-2', categoryGroupId: 'group-2', categoryId: 'cat-aisle-3' },
          ],
          recipeId: 'recipe-1', photoIds: ['photo-1'], productUpc: '012345',
          prices: [{ amount: 3.49, details: 'gallon', date: '2026-10-01' }, { amount: 2.99, storeId: 'store-costco' }],
          storeIds: ['store-costco'],
        },
        { identifier: 'item-oats', listId: 'list-1', name: 'Oats', categoryMatchId: 'bulk-bins' },
      ],
    });
    const stores = [
      { identifier: 'store-costco', listId: 'list-1', name: 'Costco', sortIndex: 0 },
      { identifier: 'store-safeway', listId: 'list-1', name: 'Safeway', sortIndex: 4 },
    ];
    const list = new List(rawList, { client: http, protobuf: pb, uid: 'user-1', stores });
    list._setCategoryGroups([
      {
        categoryGroup: {
          identifier: 'group-1', name: 'Grocery', listId: 'list-1', defaultCategoryId: 'cat-other',
          categories: [
            { identifier: 'cat-other', categoryGroupId: 'group-1', name: 'Other', systemCategory: 'other', sortIndex: 2 },
            { identifier: 'cat-dairy', categoryGroupId: 'group-1', name: 'Dairy', systemCategory: 'dairy', sortIndex: 0 },
            { identifier: 'cat-bulk', categoryGroupId: 'group-1', name: 'Bulk Bins', sortIndex: 1 },
          ],
        },
      },
      {
        categoryGroup: {
          identifier: 'group-2', name: 'Aisles', listId: 'list-1',
          categories: [{ identifier: 'cat-aisle-3', categoryGroupId: 'group-2', name: 'Aisle 3' }],
        },
      },
    ]);

    client = new AnyListClient();
    client.client = {
      protobuf: pb,
      uid: 'user-1',
      client: http,
      lists: [list],
      _userData: { shoppingListsResponse: { newLists: [rawList] } },
      createItem: (fields) => new (require('./item.js'))(fields, { client: http, protobuf: pb, uid: 'user-1' }),
    };
    client.targetList = list;
  });

  describe('categories', () => {
    it('lists categories by group, in AnyList order', () => {
      assert.deepEqual(client.getCategories(), [
        { group: 'Grocery', categories: ['Dairy', 'Bulk Bins', 'Other'] },
        { group: 'Aisles', categories: ['Aisle 3'] },
      ]);
    });

    it('finds a category by display name or built-in slug', () => {
      assert.equal(client.findCategory('bulk bins').category.identifier, 'cat-bulk');
      assert.equal(client.findCategory('dairy').category.identifier, 'cat-dairy');
      assert.equal(client.findCategory('Bulk-Bins').category.identifier, 'cat-bulk');
      assert.equal(client.findCategory('nope'), null);
    });

    it('moves an item with the two operations AnyList Web sends, each carrying the whole item', async () => {
      const shownAs = await client.setItemCategory('Milk', 'Bulk Bins');
      assert.equal(shownAs, 'Bulk Bins');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].path, 'data/shopping-lists/update');
      const [assign, match] = decodeSentOperations(posts[0].body);

      assert.equal(assign.metadata.handlerId, 'update-list-item-category-assignment');
      assert.equal(assign.metadata.userId, 'user-1');
      assert.equal(assign.listId, 'list-1');
      assert.equal(assign.listItemId, 'item-milk');
      assert.deepEqual(
        assign.listItem.categoryAssignments.map(a => [a.identifier, a.categoryGroupId, a.categoryId]),
        [['assign-2', 'group-2', 'cat-aisle-3'], [GROUP_1_ASSIGNMENT_ID, 'group-1', 'cat-bulk']],
      );
      assert.equal(assign.listItem.categoryMatchId, 'other', 'match ID changes in the second operation');

      assert.equal(match.metadata.handlerId, 'set-list-item-category-match-id');
      assert.equal(match.originalValue, 'bulk-bins');
      assert.equal(match.updatedValue, null);
      assert.equal(match.listItem.categoryMatchId, 'bulk-bins');
      assert.equal(match.listItem.category, 'other');

      for (const op of [assign, match]) {
        const item = op.listItem;
        assert.equal(item.name, 'Milk');
        assert.equal(item.details, '2%');
        assert.equal(item.recipeId, 'recipe-1');
        assert.deepEqual(item.photoIds, ['photo-1']);
        assert.equal(item.productUpc, '012345');
        assert.deepEqual(item.storeIds, ['store-costco']);
        assert.deepEqual(item.prices.map(p => [p.amount, p.storeId]), [[3.49, null], [2.99, 'store-costco']]);
      }
    });

    it('uses the system slug for a built-in category and shows the item under it', async () => {
      await client.setItemCategory('Milk', 'Dairy');
      const [, match] = decodeSentOperations(posts[0].body);
      assert.equal(match.originalValue, 'dairy');
      assert.equal(match.listItem.category, 'dairy');
      const milk = (await client.getItems()).find(i => i.name === 'Milk');
      assert.equal(milk.category, 'Dairy');
    });

    it('creates a new item already assigned to its category', async () => {
      await client.addItem('Rice', 1, null, 'Bulk Bins');
      const [op] = decodeSentOperations(posts[0].body);
      assert.equal(op.metadata.handlerId, 'add-shopping-list-item');
      assert.equal(op.listItem.categoryMatchId, 'bulk-bins');
      assert.equal(op.listItem.category, 'other');
      assert.deepEqual(
        op.listItem.categoryAssignments.map(a => [a.identifier, a.categoryGroupId, a.categoryId]),
        [[GROUP_1_ASSIGNMENT_ID, 'group-1', 'cat-bulk']],
      );
    });

    it('names an item\'s category from its assignment, else its match ID', async () => {
      const items = await client.getItems();
      assert.equal(items.find(i => i.name === 'Milk').category, 'Other');
      assert.equal(items.find(i => i.name === 'Oats').category, 'Bulk Bins');
    });
  });

  describe('stores', () => {
    it('creates a store with AnyList Web\'s new-store operation, after the other stores', async () => {
      const store = await client.createStore('Trader Joes');
      assert.equal(posts[0].path, 'data/shopping-lists/update-v2');
      const [op] = decodeSentOperations(posts[0].body);
      assert.equal(op.metadata.handlerId, 'new-store');
      assert.equal(op.metadata.operationClass, 1);
      assert.equal(op.listId, 'list-1');
      assert.equal(op.updatedStore.identifier, store.identifier);
      assert.equal(op.updatedStore.name, 'Trader Joes');
      assert.equal(op.updatedStore.listId, 'list-1');
      assert.equal(op.updatedStore.sortIndex, 5);
      assert.ok(client.getStores().some(s => s.name === 'Trader Joes'));
    });

    it('refuses a duplicate store name', async () => {
      await assert.rejects(client.createStore('costco'), /already exists/);
      assert.equal(posts.length, 0);
    });

    it('assigns a store by name regardless of case', async () => {
      await client.setItemStore('Oats', 'safeway');
      const [op] = decodeSentOperations(posts[0].body);
      assert.equal(op.metadata.handlerId, 'add-list-item-store-id');
      assert.equal(op.updatedValue, 'store-safeway');
    });

    it('lists every store an item is assigned to', async () => {
      const milk = (await client.getItems()).find(i => i.name === 'Milk');
      assert.deepEqual(milk.stores, ['Costco']);
    });
  });

  describe('prices', () => {
    it('reads the main price and store prices', async () => {
      const milk = (await client.getItems()).find(i => i.name === 'Milk');
      assert.equal(milk.price, 3.49);
      assert.deepEqual(milk.storePrices, [{ store: 'Costco', amount: 2.99 }]);
    });

    it('sets the main price with save-item-price, keeping its details and date', async () => {
      await client.setItemPrice('Milk', 3.79);
      const [op] = decodeSentOperations(posts[0].body);
      assert.equal(op.metadata.handlerId, 'save-item-price');
      assert.equal(op.listId, 'list-1');
      assert.equal(op.listItemId, 'item-milk');
      assert.equal(op.itemPrice.amount, 3.79);
      assert.equal(op.itemPrice.storeId, null);
      assert.equal(op.itemPrice.details, 'gallon');
      assert.equal(op.itemPrice.date, '2026-10-01');
      assert.equal((await client.getItems()).find(i => i.name === 'Milk').price, 3.79);
    });

    it('sets a store price', async () => {
      await client.setItemPrice('Oats', 1.25, 'Safeway');
      const [op] = decodeSentOperations(posts[0].body);
      assert.equal(op.itemPrice.storeId, 'store-safeway');
      assert.equal(op.itemPrice.amount, 1.25);
      const oats = (await client.getItems()).find(i => i.name === 'Oats');
      assert.equal(oats.price, null);
      assert.deepEqual(oats.storePrices, [{ store: 'Safeway', amount: 1.25 }]);
    });

    it('clears a price with an entry that has no amount', async () => {
      await client.setItemPrice('Milk', 0, 'Costco');
      const [op] = decodeSentOperations(posts[0].body);
      assert.equal(op.itemPrice.storeId, 'store-costco');
      assert.equal(op.itemPrice.amount, null);
      assert.equal((await client.getItems()).find(i => i.name === 'Milk').storePrices, undefined);
    });

    it('prices an item added since the snapshot', async () => {
      await client.addItem('Rice');
      await client.setItemPrice('Rice', 2);
      assert.equal((await client.getItems()).find(i => i.name === 'Rice').price, 2);
    });

    it('rejects a negative price without sending anything', async () => {
      await assert.rejects(client.setItemPrice('Milk', -1), /Invalid price/);
      assert.equal(posts.length, 0);
    });
  });
});
