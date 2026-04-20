import { AggregateRoot, DomainEvent } from '@quilla-kit/ddd';

type TestProps = { readonly name: string };

export class TestCreatedEvent extends DomainEvent<{ name: string }> {}

export class TestAggregate extends AggregateRoot<TestProps> {
  static create(id: string, name: string): TestAggregate {
    const agg = new TestAggregate({ id, name });
    agg.addDomainEvent(new TestCreatedEvent(id, { name }));
    return agg;
  }

  emitCreated(): void {
    this.addDomainEvent(new TestCreatedEvent(this.id, { name: this.props.name }));
  }
}
