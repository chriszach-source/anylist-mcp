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
      _userData: {
        shoppingListsResponse: {
          newLists: [rawList],
          // Costco's store filter uses the Aisles set as Costco's own categories.
          listResponses: [{ listId: 'list-1', storeFilters: [
            { identifier: 'filter-costco', listId: 'list-1', name: 'Costco', storeIds: ['store-costco'], listCategoryGroupId: 'group-2' },
            { identifier: 'filter-safeway', listId: 'list-1', name: 'Safeway', storeIds: ['store-safeway'], listCategoryGroupId: 'group-1' },
          ] }],
        },
        listSettingsResponse: { settings: [] },
      },
      createItem: (fields) => new (require('./item.js'))(fields, { client: http, protobuf: pb, uid: 'user-1' }),
    };
    client.targetList = list;
  });

  describe('categories', () => {
    it('lists categories by group, in AnyList order', () => {
      assert.deepEqual(client.getCategories(), [
        { group: 'Grocery', stores: [], categories: ['Dairy', 'Bulk Bins', 'Other'] },
        { group: 'Aisles', stores: ['Costco'], categories: ['Aisle 3'] },
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
      assert.equal(posts.length, 2, 'the move, then the categorization rule');
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
  describe('categorization rules', () => {
    const MILK_GROCERY_RULE = '6a6d394efafa5b4084f4669663ccafd2'; // Python uuid5(rule namespace, 'milk' + 'group-1' + 'list-1').hex

    it('saves the rule after a move, so the category sticks the next time the item is added', async () => {
      await client.setItemCategory('Milk', 'Dairy');
      assert.equal(posts[1].path, 'data/shopping-lists/update-v2');
      const [op] = decodeSentOperations(posts[1].body);
      assert.equal(op.metadata.handlerId, 'save-categorization-rule');
      assert.equal(op.metadata.operationClass, 5);
      assert.equal(op.listId, 'list-1');
      const rule = op.updatedCategorizationRule;
      assert.equal(rule.identifier, MILK_GROCERY_RULE);
      assert.equal(rule.listId, 'list-1');
      assert.equal(rule.categoryGroupId, 'group-1');
      assert.equal(rule.itemName, 'milk');
      assert.equal(rule.categoryId, 'cat-dairy');
    });

    it('skips the rule when the list doesn\'t remember item categories', async () => {
      client.client._userData.listSettingsResponse.settings = [{ identifier: 's', listId: 'list-1', shouldRememberItemCategories: false }];
      await client.setItemCategory('Milk', 'Dairy');
      assert.equal(posts.length, 1);
    });
  });

  describe('a store\'s own category set', () => {
    it('lists the store\'s categories', () => {
      assert.deepEqual(client.getCategories('costco'), [{ group: 'Aisles', stores: ['Costco'], categories: ['Aisle 3'] }]);
    });

    it('moves an item within the store\'s set with only the assignment and that set\'s rule', async () => {
      await client.createCategory('Aisle 12', 'Costco');
      posts.length = 0;
      const shownAs = await client.setItemCategory('Milk', 'aisle 12', 'Costco');
      assert.equal(shownAs, 'Aisle 12');
      const ops = decodeSentOperations(posts[0].body);
      assert.deepEqual(ops.map(o => o.metadata.handlerId), ['update-list-item-category-assignment']);
      const aisle12 = client.targetList.categoryGroups[1].categories.find(c => c.name === 'Aisle 12');
      assert.deepEqual(
        ops[0].listItem.categoryAssignments.map(a => [a.identifier, a.categoryGroupId, a.categoryId]),
        [[GROUP_1_ASSIGNMENT_ID, 'group-1', 'cat-other'], ['cab031b41c2851239b2e4acfb2433f77', 'group-2', aisle12.identifier]],
      );
      assert.equal(ops[0].listItem.categoryMatchId, 'other', 'the main category is unchanged');
      const [rule] = decodeSentOperations(posts[1].body);
      assert.equal(rule.updatedCategorizationRule.categoryGroupId, 'group-2');
      assert.equal(rule.updatedCategorizationRule.identifier, '27c5573c2d4a56fa8382fa649a9a7112');
    });

    it('adds an aisle to the store\'s set, after its other categories', async () => {
      await client.createCategory('Aisle 12', 'Costco');
      const [op] = decodeSentOperations(posts[0].body);
      assert.equal(op.metadata.handlerId, 'create-category');
      assert.equal(op.updatedCategory.categoryGroupId, 'group-2');
      assert.equal(op.updatedCategory.name, 'Aisle 12');
    });

    it('doesn\'t find a store-set category without the store, or a main one with it', () => {
      assert.equal(client.findCategory('Aisle 3'), null);
      assert.equal(client.findCategory('Dairy', 'Costco'), null);
    });

    it('names an item\'s category from the store\'s set when the store is named', async () => {
      assert.equal(client._categoryNameForItem(client.targetList.getItemByName('Milk'), 'Costco'), 'Aisle 3');
      assert.equal(client._categoryNameForItem(client.targetList.getItemByName('Milk')), 'Other');
    });

    it('says when a store has no set of its own', async () => {
      assert.throws(() => client.getCategories('Safeway'), /Safeway doesn't have its own category set/);
      await assert.rejects(client.setItemCategory('Milk', 'Dairy', 'Safeway'), /doesn't have its own category set/);
      assert.equal(posts.length, 0);
    });

    it('uses the category set the list\'s settings select as the main set', () => {
      client.client._userData.listSettingsResponse.settings = [{ identifier: 's', listId: 'list-1', listCategoryGroupId: 'group-2' }];
      assert.equal(client.findCategory('Aisle 3').category.identifier, 'cat-aisle-3');
      assert.equal(client.findCategory('Dairy'), null);
    });
  });

  describe('editing an item', () => {
    it('renames, sets notes, and sets quantity with the v2 operation, carrying the categories to the new name', async () => {
      const result = await client.updateItem('Milk', { newName: ' Whole Milk ', notes: 'organic', quantity: '2 gallons' });
      assert.deepEqual(result, { name: 'Whole Milk', quantity: '2 gallons', notes: 'organic' });

      const fields = decodeSentOperations(posts[0].body);
      assert.deepEqual(fields.map(o => [o.metadata.handlerId, o.updatedValue]),
        [['set-list-item-name', 'Whole Milk'], ['set-list-item-details', 'organic']]);

      const [qty] = decodeSentOperations(posts[1].body);
      assert.equal(qty.metadata.handlerId, 'set-list-item-quantity-v2');
      assert.equal(qty.listItemId, 'item-milk');
      assert.equal(qty.listItem.quantityPb.rawQuantity, '2 gallons');
      assert.equal(qty.listItem.quantityPb.amount, '2');
      assert.equal(qty.listItem.quantityPb.unit, 'gallons');
      assert.equal(qty.listItem.deprecatedQuantity, '2 gallons');
      assert.equal(qty.listItem.name, null, 'a partial item, so nothing else is overwritten');

      const rules = decodeSentOperations(posts[2].body).map(o => o.updatedCategorizationRule);
      assert.deepEqual(rules.map(r => [r.identifier, r.itemName, r.categoryGroupId, r.categoryId]), [
        ['ed696e7ccb4854e58fed0866226d583b', 'whole milk', 'group-1', 'cat-other'],
        ['4cd6f18fd0b0502eba5f051405d7a3c1', 'whole milk', 'group-2', 'cat-aisle-3'],
      ]);
    });

    it('changes only what it\'s given, and a later save doesn\'t resend it', async () => {
      await client.updateItem('Milk', { notes: '' });
      await client.updateItem('Milk', { quantity: 3 });
      assert.deepEqual(decodeSentOperations(posts[0].body).map(o => o.metadata.handlerId), ['set-list-item-details']);
      assert.deepEqual(decodeSentOperations(posts[1].body).map(o => o.metadata.handlerId), ['set-list-item-quantity-v2']);
      assert.equal(posts.length, 2);
    });

    it('refuses a name another item has, and writes nothing', async () => {
      await assert.rejects(client.updateItem('Milk', { newName: 'oats', notes: 'x' }), /An item named "Oats" is already on the list/);
      assert.equal(posts.length, 0);
    });

    it('sets an existing item\'s new quantity on add with the v2 operation', async () => {
      await client.addItem('Oats', '2 lb');
      const handlers = posts.flatMap(p => decodeSentOperations(p.body).map(o => o.metadata.handlerId));
      assert.deepEqual(handlers, ['set-list-item-quantity-v2']);
    });
  });

  describe('fresh lists', () => {
    it('follows the list by ID when the library replaces its list objects', async () => {
      const replacement = new List(decoded('ShoppingList', {
        identifier: 'list-1', name: 'Grocery List',
        items: [{ identifier: 'item-eggs', listId: 'list-1', name: 'Eggs' }],
      }), { client: client.client.client, protobuf: pb, uid: 'user-1', stores: [] });
      client.client.lists = [replacement];
      assert.equal(client.targetList, replacement);
      assert.deepEqual((await client.getItems()).map(i => i.name), ['Eggs']);
    });

    it('re-reads the lists when called again, but not twice within a few seconds', async () => {
      let reads = 0;
      client.client.getLists = async () => { reads++; };
      client._username = 'u'; client._password = 'p';
      await client.connect('Grocery List');
      await client.connect('Grocery List');
      assert.equal(reads, 1);
      client._listsFetchedAt = Date.now() - 6000;
      await client.connect('Grocery List');
      assert.equal(reads, 2);
    });
  });
});
