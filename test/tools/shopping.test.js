import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { register } from '../../src/tools/shopping.js';
import { MockAnyListClient, createMockServer } from './helpers.js';

describe('shopping tool', () => {
  let client;
  let handlers;

  beforeEach(() => {
    client = new MockAnyListClient();
    const { server, handlers: h } = createMockServer();
    register(server, () => Promise.resolve(client));
    handlers = h;
  });

  describe('add_item', () => {
    it('adds an item', async () => {
      const result = await handlers.shopping({ action: 'add_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully added "Milk"'));
      assert.equal(client._items.length, 1);
      assert.equal(client._items[0].name, 'Milk');
    });

    it('adds item with quantity and notes', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Eggs', quantity: 2, notes: 'organic' });
      assert.equal(client._items[0].quantity, 2);
      assert.equal(client._items[0].notes, 'organic');
    });

    it('accepts a string quantity with a unit', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Flour', quantity: '500 g' });
      assert.equal(client._items[0].quantity, '500 g');
    });


    it ('should default to "other" category if not provided', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Bread' });
      assert.equal(client._items[0].category, 'other');
    });

    it('should set category when provided', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Bananas', category: 'produce' });
      assert.equal(client._items[0].category, 'produce');
    });

    it('should return error for invalid category', async () => {
      const result = await handlers.shopping({ action: 'add_item', name: 'Soda', category: 'invalid-category' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Category "invalid-category" not found'));
      assert.ok(result.content[0].text.includes('Available categories: Produce, Dairy'));
      assert.equal(client._items.length, 0);
    });
  });

  describe('add_items', () => {
    it('adds multiple items from plain names', async () => {
      const result = await handlers.shopping({ action: 'add_items', items: ['Milk', 'Eggs', 'Bread'] });
      assert.ok(result.content[0].text.includes('Added 3 of 3 items'));
      assert.equal(client._items.length, 3);
      assert.deepEqual(client._items.map(i => i.name), ['Milk', 'Eggs', 'Bread']);
    });

    it('adds items with quantity, notes and category', async () => {
      await handlers.shopping({
        action: 'add_items',
        items: [{ name: 'Eggs', quantity: 2, notes: 'organic', category: 'dairy' }],
      });
      assert.equal(client._items[0].quantity, 2);
      assert.equal(client._items[0].notes, 'organic');
      assert.equal(client._items[0].category, 'dairy');
    });

    it('defaults quantity to 1 and category to other', async () => {
      await handlers.shopping({ action: 'add_items', items: ['Milk'] });
      assert.equal(client._items[0].quantity, 1);
      assert.equal(client._items[0].category, 'other');
    });

    it('mixes plain names and objects', async () => {
      await handlers.shopping({ action: 'add_items', items: ['Milk', { name: 'Eggs', quantity: 12 }] });
      assert.equal(client._items.length, 2);
      assert.equal(client._items[1].quantity, 12);
    });

    it('continues past a failing item and reports it', async () => {
      client.addItem = async (name) => {
        if (name === 'Eggs') throw new Error('boom');
        client._items.push({ name });
      };
      const result = await handlers.shopping({ action: 'add_items', items: ['Milk', 'Eggs', 'Bread'] });
      const text = result.content[0].text;
      assert.equal(result.isError, true);
      assert.ok(text.includes('Added 2 of 3 items'));
      assert.ok(text.includes('✓ Milk'));
      assert.ok(text.includes('✗ Eggs: boom'));
      assert.ok(text.includes('✓ Bread'));
      assert.deepEqual(client._items.map(i => i.name), ['Milk', 'Bread']);
    });

    it('rejects an invalid category without aborting the batch', async () => {
      const result = await handlers.shopping({
        action: 'add_items',
        items: [{ name: 'Soda', category: 'invalid-category' }, 'Milk'],
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Category "invalid-category" not found'));
      assert.deepEqual(client._items.map(i => i.name), ['Milk']);
    });

    it('assigns a store to an item', async () => {
      client._stores = [{ name: 'Costco' }];
      await handlers.shopping({ action: 'add_items', items: [{ name: 'Milk', store_name: 'Costco' }] });
      assert.equal(client._items[0].store, 'Costco');
    });

    it('rejects an unknown store without aborting the batch', async () => {
      client._stores = [{ name: 'Costco' }];
      const result = await handlers.shopping({
        action: 'add_items',
        items: [{ name: 'Milk', store_name: 'Nowhere' }, 'Eggs'],
      });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Store "Nowhere" not found'));
      assert.deepEqual(client._items.map(i => i.name), ['Eggs']);
    });

    it('errors on a missing or empty items array', async () => {
      const missing = await handlers.shopping({ action: 'add_items' });
      assert.equal(missing.isError, true);
      assert.ok(missing.content[0].text.includes('non-empty "items" array'));

      const empty = await handlers.shopping({ action: 'add_items', items: [] });
      assert.equal(empty.isError, true);
    });

    it('connects to the list only once for the whole batch', async () => {
      let connects = 0;
      const realConnect = client.connect.bind(client);
      client.connect = async (n) => { connects++; return realConnect(n); };
      await handlers.shopping({ action: 'add_items', items: ['Milk', 'Eggs', 'Bread'] });
      assert.equal(connects, 1);
    });
  });

  describe('check_item', () => {
    it('checks off an existing item', async () => {
      client._items.push({ name: 'Milk', checked: false });
      const result = await handlers.shopping({ action: 'check_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully checked off'));
      assert.equal(client._items[0].checked, true);
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'check_item', name: 'Nonexistent' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('not found'));
    });
  });

  describe('uncheck_item', () => {
    it('unchecks a checked-off item', async () => {
      client._items.push({ name: 'Milk', checked: true });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully unchecked'));
      assert.equal(client._items[0].checked, false);
    });

    it('resolves a checked item by partial name', async () => {
      client._items.push({ name: 'Whole Milk', checked: true });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'milk' });
      assert.ok(result.content[0].text.includes('Successfully unchecked'));
      assert.equal(client._items[0].checked, false);
    });

    it('returns error when no checked item matches', async () => {
      client._items.push({ name: 'Milk', checked: false });
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Milk' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('No checked-off item'));
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'uncheck_item', name: 'Ghost' });
      assert.equal(result.isError, true);
    });
  });

  describe('delete_item', () => {
    it('deletes an existing item', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'delete_item', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Successfully deleted'));
      assert.equal(client._items.length, 0);
    });

    it('returns error for non-existent item', async () => {
      const result = await handlers.shopping({ action: 'delete_item', name: 'Ghost' });
      assert.equal(result.isError, true);
    });
  });

  describe('list_items', () => {
    it('returns empty message when no items', async () => {
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('No unchecked items'));
    });

    it('lists items grouped by category', async () => {
      client._items.push({ name: 'Milk', category: 'Dairy' }, { name: 'Bread', category: 'Bakery' });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Milk'));
      assert.ok(result.content[0].text.includes('Bread'));
      assert.ok(result.content[0].text.includes('Dairy'));
      assert.ok(result.content[0].text.includes('Bakery'));
    });

    it('renders quantities (including units) next to the item', async () => {
      client._items.push({ name: 'Flour', quantity: '500 g' }, { name: 'Eggs', quantity: 12 });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Flour (500 g)'));
      assert.ok(result.content[0].text.includes('Eggs (12)'));
    });

    it('excludes checked items by default', async () => {
      client._items.push({ name: 'Milk', checked: false }, { name: 'Done', checked: true });
      const result = await handlers.shopping({ action: 'list_items' });
      assert.ok(result.content[0].text.includes('Milk'));
      assert.ok(!result.content[0].text.includes('Done'));
    });

    it('includes checked items when requested', async () => {
      client._items.push({ name: 'Milk', checked: false }, { name: 'Done', checked: true });
      const result = await handlers.shopping({ action: 'list_items', include_checked: true });
      assert.ok(result.content[0].text.includes('Done'));
    });

    it('includes notes when requested', async () => {
      client._items.push({ name: 'Milk', notes: 'whole milk' });
      const result = await handlers.shopping({ action: 'list_items', include_notes: true });
      assert.ok(result.content[0].text.includes('whole milk'));
    });
  });

  describe('list_lists', () => {
    it('returns empty message when no lists', async () => {
      const result = await handlers.shopping({ action: 'list_lists' });
      assert.ok(result.content[0].text.includes('No lists found'));
    });

    it('returns list names with counts', async () => {
      client._lists = [
        { name: 'Groceries', uncheckedCount: 5 },
        { name: 'Costco', uncheckedCount: 2 },
      ];
      const result = await handlers.shopping({ action: 'list_lists' });
      assert.ok(result.content[0].text.includes('Groceries'));
      assert.ok(result.content[0].text.includes('5 unchecked'));
    });
  });

  describe('get_favorites', () => {
    it('returns empty message when no favorites', async () => {
      const result = await handlers.shopping({ action: 'get_favorites' });
      assert.ok(result.content[0].text.includes('No favorite items'));
    });

    it('returns favorite items', async () => {
      client._favorites = [{ name: 'Bananas', details: 'organic' }];
      const result = await handlers.shopping({ action: 'get_favorites' });
      assert.ok(result.content[0].text.includes('Bananas'));
      assert.ok(result.content[0].text.includes('organic'));
    });
  });

  describe('get_recents', () => {
    it('returns empty message when no recents', async () => {
      const result = await handlers.shopping({ action: 'get_recents' });
      assert.ok(result.content[0].text.includes('No recent items'));
    });

    it('returns recent items', async () => {
      client._recents = [{ name: 'Avocado' }];
      const result = await handlers.shopping({ action: 'get_recents' });
      assert.ok(result.content[0].text.includes('Avocado'));
    });
  });
  describe('stores', () => {
    beforeEach(() => { client._stores = [{ name: 'Costco' }, { name: 'Safeway' }]; });

    it('set_item_store assigns a store', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_store', name: 'Milk', store_name: 'Costco' });
      assert.ok(result.content[0].text.includes('Assigned "Milk" to Costco'));
      assert.equal(client._items[0].store, 'Costco');
    });

    it('set_item_store clears the store when store_name is omitted', async () => {
      client._items.push({ name: 'Milk', store: 'Costco' });
      const result = await handlers.shopping({ action: 'set_item_store', name: 'Milk' });
      assert.ok(result.content[0].text.includes('Cleared the store'));
      assert.equal(client._items[0].store, null);
    });

    it('set_item_store rejects an unknown store', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_store', name: 'Milk', store_name: 'Nowhere' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Store "Nowhere" not found'));
    });

    it('list_items with store_name shows only that store\'s items', async () => {
      client._items.push({ name: 'Milk', store: 'Costco' }, { name: 'Bread', store: 'Safeway' }, { name: 'Eggs' });
      const text = (await handlers.shopping({ action: 'list_items', store_name: 'costco' })).content[0].text;
      assert.ok(text.includes('at costco (1 items)'));
      assert.ok(text.includes('Milk'));
      assert.ok(!text.includes('Bread'));
      assert.ok(!text.includes('Eggs'));
    });

    it('list_items shows each item\'s store', async () => {
      client._items.push({ name: 'Milk', store: 'Costco' });
      const text = (await handlers.shopping({ action: 'list_items' })).content[0].text;
      assert.ok(text.includes('Milk @Costco'));
    });

    it('create_store adds a store', async () => {
      const result = await handlers.shopping({ action: 'create_store', name: 'Trader Joes' });
      assert.ok(result.content[0].text.includes('Created store "Trader Joes"'));
      assert.ok(client._stores.some(s => s.name === 'Trader Joes'));
    });

    it('create_store reports a duplicate', async () => {
      const result = await handlers.shopping({ action: 'create_store', name: 'costco' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('already exists'));
    });
  });

  describe('categories', () => {
    it('add_item accepts a category by its display name', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Milk', category: 'Dairy' });
      assert.equal(client._items[0].category, 'Dairy');
    });

    it('set_item_category moves an item', async () => {
      client._items.push({ name: 'Milk', category: 'other' });
      const result = await handlers.shopping({ action: 'set_item_category', name: 'Milk', category: 'dairy' });
      assert.ok(result.content[0].text.includes('Moved "Milk" to Dairy'));
      assert.equal(client._items[0].category, 'dairy');
    });

    it('set_item_category rejects an unknown category and lists the real ones', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_category', name: 'Milk', category: 'Nope' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Available categories: Produce, Dairy, Meat, Bakery, Other'));
    });

    it('set_item_category resolves a partial item name', async () => {
      client._items.push({ name: 'Whole Milk' });
      await handlers.shopping({ action: 'set_item_category', name: 'milk', category: 'Dairy' });
      assert.equal(client._items[0].category, 'dairy');
    });

    it('list_categories lists the list\'s categories', async () => {
      const text = (await handlers.shopping({ action: 'list_categories' })).content[0].text;
      assert.ok(text.includes('- Produce'));
      assert.ok(text.includes('- Other'));
    });

    it('create_category adds a custom category usable right away', async () => {
      const result = await handlers.shopping({ action: 'create_category', name: 'Bulk Bins' });
      assert.ok(result.content[0].text.includes('Created category "Bulk Bins"'));
      await handlers.shopping({ action: 'add_item', name: 'Oats', category: 'Bulk Bins' });
      assert.equal(client._items[0].category, 'Bulk Bins');
    });
  });

  describe('prices', () => {
    it('set_item_price sets the main price', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_price', name: 'Milk', price: 3.49 });
      assert.ok(result.content[0].text.includes('Set the price for "Milk" to $3.49'));
      assert.equal(client._items[0].price, 3.49);
    });

    it('set_item_price with store_name sets that store\'s price', async () => {
      client._stores = [{ name: 'Costco' }];
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_price', name: 'Milk', price: 2.99, store_name: 'Costco' });
      assert.ok(result.content[0].text.includes('Set the Costco price'));
      assert.deepEqual(client._items[0].storePrices, [{ store: 'Costco', amount: 2.99 }]);
      assert.equal(client._items[0].price, undefined);
    });

    it('set_item_price with 0 clears the price', async () => {
      client._items.push({ name: 'Milk', price: 3.49 });
      const result = await handlers.shopping({ action: 'set_item_price', name: 'Milk', price: 0 });
      assert.ok(result.content[0].text.includes('Cleared the price'));
      assert.equal(client._items[0].price, null);
    });

    it('set_item_price requires a price', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_price', name: 'Milk' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('requires "price"'));
    });

    it('add_item and add_items accept a price', async () => {
      await handlers.shopping({ action: 'add_item', name: 'Milk', price: 3.49 });
      await handlers.shopping({ action: 'add_items', items: [{ name: 'Eggs', price: 4 }, 'Bread'] });
      assert.deepEqual(client._items.map(i => i.price ?? null), [3.49, 4, null]);
    });

    it('list_items shows the main price and store prices', async () => {
      client._items.push({ name: 'Apples', price: 1.39, storePrices: [{ store: 'Trader Joes', amount: 1.99 }] });
      const text = (await handlers.shopping({ action: 'list_items' })).content[0].text;
      assert.ok(text.includes('Apples $1.39 (Trader Joes $1.99)'));
    });
  });
  describe('update_item', () => {
    it('says what it changed, resolving a partial name', async () => {
      client._items.push({ name: 'Pearl River Dark Soy Sauce', notes: 'the big bottle' });
      const result = await handlers.shopping({ action: 'update_item', name: 'dark soy', new_name: 'Dark Soy Sauce', quantity: 2, notes: '' });
      assert.equal(result.content[0].text, 'Updated "Pearl River Dark Soy Sauce" on list "Test List": renamed to "Dark Soy Sauce", quantity 2, notes cleared');
      assert.deepEqual(client._items[0], { name: 'Dark Soy Sauce', notes: '', quantity: 2 });
    });

    it('with nothing to change, says so and writes nothing', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'update_item', name: 'Milk' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes('Nothing to change'));
      assert.deepEqual(client._items[0], { name: 'Milk' });
    });
  });

  describe('a store\'s own categories', () => {
    beforeEach(() => {
      client._stores = [{ name: 'Costco' }, { name: 'Safeway' }];
      client._storeCategories = { Costco: [{ name: 'Aisle 3', slug: 'aisle-3' }] };
    });

    it('list_categories with store_name lists that store\'s set', async () => {
      const text = (await handlers.shopping({ action: 'list_categories', store_name: 'costco' })).content[0].text;
      assert.ok(text.startsWith("costco's categories on"));
      assert.ok(text.includes('- Aisle 3'));
    });

    it('set_item_category with store_name moves the item within the store\'s set', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_category', name: 'Milk', category: 'aisle 3', store_name: 'Costco' });
      assert.ok(result.content[0].text.includes("Moved \"Milk\" to Aisle 3 in Costco's categories"));
      assert.equal(client._items[0].storeCategory, 'Aisle 3');
    });

    it('set_item_category lists the store\'s categories when the name isn\'t one', async () => {
      client._items.push({ name: 'Milk' });
      const result = await handlers.shopping({ action: 'set_item_category', name: 'Milk', category: 'Dairy', store_name: 'Costco' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes("Category \"Dairy\" not found in Costco's categories. Available categories: Aisle 3"));
    });

    it('create_category with store_name adds an aisle to the store\'s set', async () => {
      const result = await handlers.shopping({ action: 'create_category', name: 'Aisle 12', store_name: 'Costco' });
      assert.ok(result.content[0].text.includes("Created category \"Aisle 12\" in Costco's categories"));
      assert.deepEqual(client._storeCategories.Costco.map(c => c.name), ['Aisle 3', 'Aisle 12']);
    });

    it('explains when the store has no set of its own', async () => {
      const result = await handlers.shopping({ action: 'list_categories', store_name: 'Safeway' });
      assert.equal(result.isError, true);
      assert.ok(result.content[0].text.includes("doesn't have its own category set"));
    });
  });
});
