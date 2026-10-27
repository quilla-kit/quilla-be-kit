import { describe, expect, it } from 'vitest';
import { BaseRoutineDao } from '../../src/dao/base-routine.dao.js';
import type { DatabaseTransaction } from '../../src/database/database-transaction.interface.js';
import { FakeDatabaseTransaction } from '../helpers/fake-database.js';
import { FakeRoutineDbAdapter } from '../helpers/fake-db-adapter.js';

class OrderRoutinesDao extends BaseRoutineDao {
  closeOrder(orderId: string, trx?: DatabaseTransaction) {
    return this.callProcedure<{ closed: boolean }>(
      { routine: 'close_order', args: [{ name: 'p_order_id', value: orderId }] },
      trx,
    );
  }

  orderTotal(orderId: string) {
    return this.callFunction({
      routine: 'order_total',
      returns: 'value',
      args: [{ value: orderId }],
    });
  }

  auditedTotal(orderId: string) {
    return this.callFunction({
      schema: 'audit',
      routine: 'order_total',
      args: [{ value: orderId }],
    });
  }
}

class BillingRoutinesDao extends OrderRoutinesDao {
  protected override readonly schema = 'billing';
}

describe('BaseRoutineDao', () => {
  it('forwards calls unchanged when no schema is set', async () => {
    const adapter = new FakeRoutineDbAdapter();
    adapter.procedureResults.push({ outputs: { closed: true }, rows: [] });
    adapter.functionResults.push({ outputs: {}, rows: [], returnValue: 7 });
    const dao = new OrderRoutinesDao(adapter);

    const closed = await dao.closeOrder('o-1');
    const total = await dao.orderTotal('o-1');

    expect(closed.outputs).toEqual({ closed: true });
    expect(total.returnValue).toBe(7);
    expect(adapter.procedureCalls).toEqual([
      {
        opts: { routine: 'close_order', args: [{ name: 'p_order_id', value: 'o-1' }] },
        trx: undefined,
      },
    ]);
    expect(adapter.functionCalls).toEqual([
      {
        opts: { routine: 'order_total', returns: 'value', args: [{ value: 'o-1' }] },
        trx: undefined,
      },
    ]);
  });

  it("applies the DAO's schema to calls without one", async () => {
    const adapter = new FakeRoutineDbAdapter();
    const dao = new BillingRoutinesDao(adapter);

    await dao.closeOrder('o-1');
    await dao.orderTotal('o-1');

    expect(adapter.procedureCalls[0]?.opts.schema).toBe('billing');
    expect(adapter.functionCalls[0]?.opts.schema).toBe('billing');
  });

  it("keeps a call's own schema", async () => {
    const adapter = new FakeRoutineDbAdapter();

    await new BillingRoutinesDao(adapter).auditedTotal('o-1');

    expect(adapter.functionCalls[0]?.opts.schema).toBe('audit');
  });

  it('passes the transaction through', async () => {
    const adapter = new FakeRoutineDbAdapter();
    const trx = new FakeDatabaseTransaction();

    await new OrderRoutinesDao(adapter).closeOrder('o-1', trx);

    expect(adapter.procedureCalls[0]?.trx).toBe(trx);
  });
});
