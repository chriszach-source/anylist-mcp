import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { auditRecipe, auditIngredient, auditStep, auditTitle } from '../src/style-audit.js';
import { loadStyleGuide, parseRules, styleGuideInstructions } from '../src/style-guide.js';

describe('style audit', () => {
  it('checks titles: spacing, small words, and spellings', () => {
    const rules = { titleLowercaseWords: ['and', 'with'], spellings: { tomatos: 'tomatoes' } };
    assert.deepEqual(auditTitle('Chicken With rice  and tomatos', rules), [
      'double spaces', '"With" should be lowercase', '"rice" should start with a capital',
      '"tomatos" should start with a capital', 'spelling "tomatos" → "tomatoes"',
    ]);
    assert.deepEqual(auditTitle('Chicken with Rice', rules), []);
  });

  it('checks ingredient fields', () => {
    assert.deepEqual(auditIngredient({ name: '1 tsp salt' }), ['quantity is in the name; move it to the quantity field', 'no quantity']);
    assert.deepEqual(auditIngredient({ name: 'Onion, diced', quantity: '1' }, { prepInNote: true }),
      ['text after a comma in the name belongs in the note']);
    assert.deepEqual(auditIngredient({ name: 'Sauce', quantity: '1 cup', isHeading: true }), ['heading has a quantity']);
    assert.deepEqual(auditIngredient({ name: ' Garlic', quantity: '2 cloves' }), ['name: leading/trailing spaces']);
  });

  it('requires gram weights when asked, in the quantity or the note, except for allowed names', () => {
    const rules = { requireGrams: true, noQuantityOk: ['salt', 'pepper'] };
    assert.deepEqual(auditIngredient({ name: 'Flour', quantity: '1 cup' }, rules), ['no gram weight']);
    assert.deepEqual(auditIngredient({ name: 'Flour', quantity: '125 g', note: '1 cup' }, rules), []);
    assert.deepEqual(auditIngredient({ name: 'Flour', quantity: '1 cup', note: '125g' }, rules), []);
    assert.deepEqual(auditIngredient({ name: 'Black pepper' }, rules), []);
  });

  it('checks steps', () => {
    assert.deepEqual(auditStep('1. Preheat the oven'), ['numbered by hand']);
    assert.deepEqual(auditStep('  '), ['empty step']);
    assert.deepEqual(auditStep('Mix. '), ['blank lines or spaces at start/end']);
  });

  it('collects a recipe\'s issues with where they are, including duplicates and missing nutrition', () => {
    const issues = auditRecipe({
      name: 'Salsa',
      ingredients: [{ name: 'Tomatoes', quantity: '500 g' }, { name: 'Tomatoes', quantity: '500 g' }],
      preparationSteps: ['Chop.'],
    }, { requireNutrition: true });
    assert.deepEqual(issues, ['Ingredient 2 "Tomatoes": listed twice', 'No nutrition facts']);
  });
});

describe('style guide file', () => {
  const saved = process.env.STYLE_GUIDE_FILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.STYLE_GUIDE_FILE;
    else process.env.STYLE_GUIDE_FILE = saved;
  });

  it('is off without STYLE_GUIDE_FILE, or when the file is missing', () => {
    delete process.env.STYLE_GUIDE_FILE;
    assert.equal(loadStyleGuide(), null);
    assert.equal(styleGuideInstructions(), undefined);
    process.env.STYLE_GUIDE_FILE = path.join(os.tmpdir(), 'no-such-style-guide.md');
    assert.equal(loadStyleGuide(), null);
  });

  it('reads the text and the JSON rules block, and becomes the server instructions', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sg-')), 'guide.md');
    fs.writeFileSync(file, '# Guide\n\nQuantity first.\n\n```json\n{ "requireGrams": true }\n```\n');
    process.env.STYLE_GUIDE_FILE = file;
    const guide = loadStyleGuide();
    assert.ok(guide.text.includes('Quantity first.'));
    assert.deepEqual(guide.rules, { requireGrams: true });
    assert.ok(styleGuideInstructions().includes('Quantity first.'));
  });

  it('ignores an invalid rules block', () => {
    assert.deepEqual(parseRules('```json\n{ nope\n```'), {});
    assert.deepEqual(parseRules('no block'), {});
  });
});
