export interface PersistenceMapper<TAggregate, TRow> {
  toDomain(row: TRow): TAggregate;
  toPersistence(aggregate: TAggregate): TRow;
}
