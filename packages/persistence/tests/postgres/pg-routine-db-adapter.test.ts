import { beforeEach, describe, expect, it } from 'vitest';
import { PgRoutineDbAdapter } from '../../src/postgres/pg-routine-db-adapter.js';
import { FakeDatabase } from '../helpers/fake-database.js';

describe('PgRoutineDbAdapter', () => {
  let db: FakeDatabase;
  let adapter: PgRoutineDbAdapter;

  beforeEach(() => {
    db = new FakeDatabase();
    adapter = new PgRoutineDbAdapter(db);
  });

  describe('callProcedure', () => {
    it('binds positional inputs as parameters', async () => {
      const result = await adapter.callProcedure({
        routine: 'archive_orders',
        args: [{ value: 'acme' }, { value: 30 }],
      });

      expect(db.calls).toEqual([
        { text: 'CALL archive_orders($1, $2)', params: ['acme', 30], viaTrx: false },
      ]);
      expect(result).toEqual({ outputs: {}, rows: [] });
    });

    it('renders named arguments, out placeholders and casts', async () => {
      await adapter.callProcedure({
        schema: 'billing',
        routine: 'close_order',
        args: [
          { name: 'p_order_id', value: 'o-1', type: 'uuid' },
          { name: 'p_total', mode: 'inout', value: 0, type: 'numeric(10,2)' },
          { name: 'p_closed_at', mode: 'out', type: 'timestamp(3) with time zone' },
          { name: 'p_note', mode: 'out' },
        ],
      });

      expect(db.calls[0]).toEqual({
        text: 'CALL billing.close_order(p_order_id => $1::uuid, p_total => $2::numeric(10,2), p_closed_at => NULL::timestamp(3) with time zone, p_note => NULL)',
        params: ['o-1', 0],
        viaTrx: false,
      });
    });

    it('accepts positional arguments before named ones', async () => {
      await adapter.callProcedure({
        routine: 'close_order',
        args: [{ value: 'o-1' }, { name: 'p_closed_at', mode: 'out' }],
      });

      expect(db.calls[0]?.text).toBe('CALL close_order($1, p_closed_at => NULL)');
    });

    it('returns out and inout values by name', async () => {
      db.queryResults.push({
        rows: [{ p_total: 120, p_closed_at: 'then', extra: true }],
        rowCount: 1,
      });

      const result = await adapter.callProcedure<{ p_total: number; p_closed_at: string }>({
        routine: 'close_order',
        args: [
          { name: 'p_order_id', value: 'o-1' },
          { name: 'p_total', mode: 'inout', value: 0 },
          { name: 'p_closed_at', mode: 'out' },
        ],
      });

      expect(result).toEqual({ outputs: { p_total: 120, p_closed_at: 'then' }, rows: [] });
    });

    it('reports a declared output missing from the row as undefined', async () => {
      const result = await adapter.callProcedure({
        routine: 'close_order',
        args: [{ name: 'p_closed_at', mode: 'out' }],
      });

      expect(result.outputs).toEqual({ p_closed_at: undefined });
    });

    it('runs on the given transaction', async () => {
      await adapter.callProcedure({ routine: 'refresh_totals' }, db.transaction);

      expect(db.calls[0]?.viaTrx).toBe(true);
      expect(db.transaction.queryCalls).toEqual([{ text: 'CALL refresh_totals()', params: [] }]);
    });
  });

  describe('callFunction', () => {
    it('reads a result set by default', async () => {
      const rows = [
        { id: 'a', total: 1 },
        { id: 'b', total: 2 },
      ];
      db.queryResults.push({ rows, rowCount: 2 });

      const result = await adapter.callFunction({
        routine: 'orders_since',
        args: [{ value: '2026-01-01', type: 'date' }],
      });

      expect(db.calls[0]?.text).toBe('SELECT * FROM orders_since($1::date)');
      expect(result).toEqual({ outputs: {}, rows });
    });

    it('leaves out arguments out of the call and reads them from the first row', async () => {
      db.queryResults.push({ rows: [{ total: 10, item_count: 3 }], rowCount: 1 });

      const result = await adapter.callFunction({
        routine: 'order_summary',
        args: [
          { name: 'p_order_id', value: 'o-1' },
          { name: 'total', mode: 'out' },
          { name: 'item_count', mode: 'out', type: 'integer' },
        ],
      });

      expect(db.calls[0]).toEqual({
        text: 'SELECT * FROM order_summary(p_order_id => $1)',
        params: ['o-1'],
        viaTrx: false,
      });
      expect(result.outputs).toEqual({ total: 10, item_count: 3 });
    });

    it('passes inout arguments as inputs', async () => {
      await adapter.callFunction({
        routine: 'bump',
        args: [{ name: 'counter', mode: 'inout', value: 1 }],
      });

      expect(db.calls[0]?.text).toBe('SELECT * FROM bump(counter => $1)');
      expect(db.calls[0]?.params).toEqual([1]);
    });

    it("reads a single value with returns: 'value'", async () => {
      db.queryResults.push({ rows: [{ returnValue: 42 }], rowCount: 1 });

      const result = await adapter.callFunction({
        routine: 'order_total',
        returns: 'value',
        args: [{ value: 'o-1', type: 'uuid' }],
      });

      expect(db.calls[0]?.text).toBe('SELECT order_total($1::uuid) AS "returnValue"');
      expect(result).toEqual({ outputs: {}, rows: [], returnValue: 42 });
    });

    it("rejects out arguments with returns: 'value'", async () => {
      await expect(
        adapter.callFunction({
          routine: 'order_summary',
          returns: 'value',
          args: [{ name: 'total', mode: 'out' }],
        }),
      ).rejects.toThrow(/returns: 'rows'/);
      expect(db.calls).toEqual([]);
    });

    it('runs on the given transaction', async () => {
      await adapter.callFunction({ routine: 'next_number', returns: 'value' }, db.transaction);

      expect(db.calls[0]?.viaTrx).toBe(true);
    });
  });

  describe('identifiers', () => {
    it('quotes schema, routine and argument names with quoteIdentifiers', async () => {
      const quoted = new PgRoutineDbAdapter(db, { quoteIdentifiers: true });

      await quoted.callProcedure({
        schema: 'Billing',
        routine: 'CloseOrder',
        args: [{ name: 'OrderId', value: 'o-1' }],
      });

      expect(db.calls[0]?.text).toBe('CALL "Billing"."CloseOrder"("OrderId" => $1)');
    });

    it('keeps a quoted routine name containing a dot as one identifier', async () => {
      const quoted = new PgRoutineDbAdapter(db, { quoteIdentifiers: true });

      await quoted.callProcedure({ routine: 'close.order' });

      expect(db.calls[0]?.text).toBe('CALL "close.order"()');
    });

    it.each(['close order', 'close_order; DROP TABLE x', 'billing.close_order', '"close_order"'])(
      'rejects routine name %j without quoteIdentifiers',
      async (routine) => {
        await expect(adapter.callProcedure({ routine })).rejects.toThrow(/invalid identifier/);
        expect(db.calls).toEqual([]);
      },
    );

    it('rejects invalid schema and argument names without quoteIdentifiers', async () => {
      await expect(
        adapter.callProcedure({ schema: 'bad schema', routine: 'close_order' }),
      ).rejects.toThrow(/invalid identifier "bad schema"/);
      await expect(
        adapter.callProcedure({ routine: 'close_order', args: [{ name: 'p id', value: 1 }] }),
      ).rejects.toThrow(/invalid identifier "p id"/);
    });
  });

  describe('argument validation', () => {
    it.each(['uuid', 'text[]', 'numeric(10, 2)[]', 'public.money_amount', 'double precision'])(
      'accepts type %j',
      async (type) => {
        await adapter.callProcedure({ routine: 'p', args: [{ value: 1, type }] });

        expect(db.calls[0]?.text).toBe(`CALL p($1::${type})`);
      },
    );

    it.each(['int); DROP TABLE x; --', 'text--', '', 'numeric(a)'])(
      'rejects type %j',
      async (type) => {
        await expect(
          adapter.callProcedure({ routine: 'p', args: [{ value: 1, type }] }),
        ).rejects.toThrow(/invalid type name/);
        expect(db.calls).toEqual([]);
      },
    );

    it('enforces the shared argument rules before running anything', async () => {
      await expect(
        adapter.callProcedure({ routine: 'p', args: [{ mode: 'out' }] }),
      ).rejects.toThrow('Routine "p": out arguments must be named.');
      expect(db.calls).toEqual([]);
    });
  });
});
