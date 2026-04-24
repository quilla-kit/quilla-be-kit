import { vi } from 'vitest';
import type { DatabaseResult } from '../../src/database/database-result.type.js';
import type { DatabaseTransaction } from '../../src/database/database-transaction.interface.js';
import type {
  ReadDbAdapter,
  SelectOptions,
} from '../../src/db-adapter/read-db-adapter.interface.js';
import type {
  DeleteOptions,
  ExistsOptions,
  InsertOptions,
  UpdateOptions,
  WriteDbAdapter,
} from '../../src/db-adapter/write-db-adapter.interface.js';

export class FakeReadDbAdapter implements ReadDbAdapter {
  selectCalls: SelectOptions<unknown>[] = [];
  results: unknown[][] = [];
  rawCalls: { sql: string; params: readonly unknown[] }[] = [];
  rawResults: unknown[][] = [];

  select<T>(opts: SelectOptions<T>): Promise<readonly T[]> {
    this.selectCalls.push(opts as SelectOptions<unknown>);
    return Promise.resolve((this.results.shift() ?? []) as readonly T[]);
  }

  raw<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]> {
    this.rawCalls.push({ sql, params });
    return Promise.resolve((this.rawResults.shift() ?? []) as readonly T[]);
  }
}

type Call<TOpts> = { opts: TOpts; trx: DatabaseTransaction | undefined };

export class FakeWriteDbAdapter implements WriteDbAdapter {
  insertCalls: Call<InsertOptions>[] = [];
  updateCalls: Call<UpdateOptions<unknown>>[] = [];
  deleteCalls: Call<DeleteOptions<unknown>>[] = [];
  findCalls: Call<SelectOptions<unknown>>[] = [];
  findForUpdateCalls: { opts: SelectOptions<unknown>; trx: DatabaseTransaction }[] = [];
  existsCalls: Call<ExistsOptions<unknown>>[] = [];

  insertResults: DatabaseResult[] = [];
  updateResults: DatabaseResult[] = [];
  deleteResults: DatabaseResult[] = [];
  findResults: unknown[][] = [];
  findForUpdateResults: unknown[][] = [];
  existsResults: boolean[] = [];

  insert = vi.fn(
    async (opts: InsertOptions, trx?: DatabaseTransaction): Promise<DatabaseResult> => {
      this.insertCalls.push({ opts, trx });
      return this.insertResults.shift() ?? { rows: [], rowCount: 1 };
    },
  );

  update = vi.fn(
    async <T>(opts: UpdateOptions<T>, trx?: DatabaseTransaction): Promise<DatabaseResult> => {
      this.updateCalls.push({ opts: opts as UpdateOptions<unknown>, trx });
      return this.updateResults.shift() ?? { rows: [], rowCount: 1 };
    },
  );

  delete = vi.fn(
    async <T>(opts: DeleteOptions<T>, trx?: DatabaseTransaction): Promise<DatabaseResult> => {
      this.deleteCalls.push({ opts: opts as DeleteOptions<unknown>, trx });
      return this.deleteResults.shift() ?? { rows: [], rowCount: 1 };
    },
  );

  find<T>(opts: SelectOptions<T>, trx?: DatabaseTransaction): Promise<readonly T[]> {
    this.findCalls.push({ opts: opts as SelectOptions<unknown>, trx });
    return Promise.resolve((this.findResults.shift() ?? []) as readonly T[]);
  }

  findForUpdate<T>(opts: SelectOptions<T>, trx: DatabaseTransaction): Promise<readonly T[]> {
    this.findForUpdateCalls.push({
      opts: opts as SelectOptions<unknown>,
      trx,
    });
    return Promise.resolve((this.findForUpdateResults.shift() ?? []) as readonly T[]);
  }

  exists = vi.fn(async <T>(opts: ExistsOptions<T>, trx?: DatabaseTransaction): Promise<boolean> => {
    this.existsCalls.push({ opts: opts as ExistsOptions<unknown>, trx });
    return this.existsResults.shift() ?? false;
  });
}
