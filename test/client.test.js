import { tmpHome } from './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SamsungFood } from '../src/client.js';
import { readSchema } from '../src/schema-build.js';

const FL = 'whisk.x.foodlist.v1.FoodlistAPI/';
const LIST = 'whisk.x.list.v1.ListAPI/';
const MP = 'whisk.x.mealplan.v2.MealPlanV2API/';

function mockClient(handlers) {
  const schema = readSchema();
  const calls = [];
  let sf;
  const transport = {
    call: async (method, payload) => {
      const request = sf.codec.decodeMessage(sf.codec.rpc(method).request, payload);
      calls.push({ method, request });
      const h = handlers[method];
      if (h === undefined) throw new Error(`unexpected call ${method}`);
      const res = typeof h === 'function' ? h(request, calls) : h;
      return sf.codec.encodeMessage(sf.codec.rpc(method).response, res);
    },
  };
  sf = new SamsungFood({ schema, transport, token: 'fake', locale: 'en-US' });
  sf._cache.mealPlan = { mealPlanId: 'plan-1' };
  return { sf, calls };
}
const of = (calls, m) => calls.filter((c) => c.method === m);

test('addPantryItems only post-processes entries matching the names it just sent', async () => {
  let added = false;
  const { sf, calls } = mockClient({
    [FL + 'GetItems']: () => ({
      items: [
        { id: 'old-1', name: 'Rice', location: { code: 3 } },
        ...(added
          ? [
              { id: 'new-1', name: 'mcp-test-apple', location: { code: 1 } },
              { id: 'foreign-1', name: 'Somebody elses item', location: { code: 1 } },
            ]
          : []),
      ],
    }),
    [FL + 'AddItems']: () => {
      added = true;
      return {};
    },
    [FL + 'UpdateItems']: () => ({}),
  });
  const created = await sf.addPantryItems(['mcp-test-apple'], { location: 'freezer' });
  assert.deepEqual(created.map((i) => i.id), ['new-1']);
  const updates = of(calls, FL + 'UpdateItems');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].request.items[0].id, 'new-1');
});

test('checkListItems sends the item content with the update and fails for unknown ids', async () => {
  const { sf, calls } = mockClient({
    [LIST + 'GetList']: { list: { id: 'l1' }, content: { items: [{ id: 'i1', item: { name: 'milk', quantity: 2 }, checked: false }] } },
    [LIST + 'SyncItems']: {},
  });
  await sf.checkListItems(['i1'], true, { listId: 'l1' });
  const sync = of(calls, LIST + 'SyncItems')[0].request;
  assert.deepEqual(sync.items[0].update, { id: 'i1', item: { name: 'milk', quantity: 2 }, checked: true });
  await assert.rejects(sf.checkListItems(['nope'], true, { listId: 'l1' }), /not found on the list/);
});

test('applyTemplate with replace clears max(orderDay)+1 days, gaps included', async () => {
  const { sf, calls } = mockClient({
    'whisk.x.mealplan.v2.MealPlanTemplateAPI/GetTemplate': {
      mealPlanTemplate: { id: 't1', title: 'x', mealsTemplate: [{ orderDay: 0, mealTime: 3 }, { orderDay: 4, mealTime: 3 }] },
    },
    [MP + 'ClearScheduledMeals']: {},
    [MP + 'ApplyMealPlanTemplate']: {},
    [MP + 'GetMealSchedule']: {},
  });
  await sf.applyTemplate('t1', { startDate: '2026-12-01', replace: true });
  const clear = of(calls, MP + 'ClearScheduledMeals')[0].request;
  assert.deepEqual(clear.period.startDate, { year: 2026, month: 12, day: 1 });
  assert.deepEqual(clear.period.endDate, { year: 2026, month: 12, day: 5 }, 'five days: orderDay 0..4');
});

test('clearWeek and schedule validate the range', async () => {
  const { sf } = mockClient({});
  await assert.rejects(sf.clearWeek({ from: '2026-12-10', to: '2026-12-01' }), /must not be after/);
  await assert.rejects(sf.schedule({ from: '2026-01-01', to: '2026-12-31' }), /too long/);
});
