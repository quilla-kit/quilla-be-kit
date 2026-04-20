import { vi } from 'vitest';
import type {
  ReadQueryBuilder,
  SelectOptions,
} from '../../src/query/read-query-builder.interface.js';
import type { SqlStatement } from '../../src/query/sql-statement.type.js';
import type {
  DeleteOptions,
  InsertOptions,
  SelectForUpdateOptions,
  UpdateOptions,
  WriteQueryBuilder,
} from '../../src/query/write-query-builder.interface.js';

export class FakeReadQueryBuilder implements ReadQueryBuilder {
  selectCalls: SelectOptions<unknown>[] = [];

  select<T>(opts: SelectOptions<T>): SqlStatement {
    this.selectCalls.push(opts as SelectOptions<unknown>);
    return {
      text: `SELECT FROM ${opts.table}`,
      params: [],
    };
  }
}

export class FakeWriteQueryBuilder implements WriteQueryBuilder {
  insertCalls: InsertOptions[] = [];
  updateCalls: UpdateOptions<unknown>[] = [];
  deleteCalls: DeleteOptions<unknown>[] = [];
  selectForUpdateCalls: SelectForUpdateOptions<unknown>[] = [];

  insert = vi.fn((opts: InsertOptions): SqlStatement => {
    this.insertCalls.push(opts);
    return { text: `INSERT INTO ${opts.table}`, params: [] };
  });

  update = vi.fn(<T>(opts: UpdateOptions<T>): SqlStatement => {
    this.updateCalls.push(opts as UpdateOptions<unknown>);
    return { text: `UPDATE ${opts.table}`, params: [] };
  });

  delete = vi.fn(<T>(opts: DeleteOptions<T>): SqlStatement => {
    this.deleteCalls.push(opts as DeleteOptions<unknown>);
    return { text: `DELETE FROM ${opts.table}`, params: [] };
  });

  selectForUpdate = vi.fn(<T>(opts: SelectForUpdateOptions<T>): SqlStatement => {
    this.selectForUpdateCalls.push(opts as SelectForUpdateOptions<unknown>);
    return { text: `SELECT FROM ${opts.table} FOR UPDATE`, params: [] };
  });
}
