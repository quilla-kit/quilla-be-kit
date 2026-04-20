import { describe, expect, it } from 'vitest';
import { AggregateRoot } from '../../src/entities/aggregate-root.js';
import type { BaseEntityProps } from '../../src/entities/entity.js';
import { DomainEvent } from '../../src/events/domain-event.js';

class Bumped extends DomainEvent<{ by: number }> {}

interface LineProps {
  readonly total: number;
}

class Line extends AggregateRoot<LineProps> {
  bump(by: number): void {
    this.addDomainEvent(new Bumped(this.id, { by }));
  }
}

interface OrderProps {
  readonly label: string;
}

class Order extends AggregateRoot<OrderProps> {
  constructor(
    props: OrderProps & BaseEntityProps,
    private readonly lines: Line[] = [],
    id?: string,
  ) {
    super(props, id);
  }

  bump(by: number): void {
    this.addDomainEvent(new Bumped(this.id, { by }));
  }

  getLines(): readonly Line[] {
    return this.lines;
  }

  /** Demonstrates the override pattern for aggregates with child aggregates. */
  override drainDomainEvents(): DomainEvent[] {
    const own = super.drainDomainEvents();
    const childEvents = this.lines.flatMap((line) => line.drainDomainEvents());
    return [...own, ...childEvents];
  }
}

describe('AggregateRoot', () => {
  it('returns no events when nothing has been raised', () => {
    const order = new Order({ label: 'x' }, [], 'o-1');
    expect(order.drainDomainEvents()).toEqual([]);
  });

  it('drains events and clears the buffer', () => {
    const order = new Order({ label: 'x' }, [], 'o-1');
    order.bump(1);
    order.bump(2);

    const first = order.drainDomainEvents();
    expect(first).toHaveLength(2);
    expect(order.drainDomainEvents()).toEqual([]);
  });

  it('drains child aggregates when the subclass overrides to include them', () => {
    const lineA = new Line({ total: 10 }, 'l-a');
    const lineB = new Line({ total: 20 }, 'l-b');
    const order = new Order({ label: 'x' }, [lineA, lineB], 'o-1');

    order.bump(1);
    lineA.bump(2);
    lineA.bump(3);
    lineB.bump(4);

    const drained = order.drainDomainEvents();
    expect(drained).toHaveLength(4);

    expect(order.drainDomainEvents()).toEqual([]);
    expect(lineA.drainDomainEvents()).toEqual([]);
    expect(lineB.drainDomainEvents()).toEqual([]);
  });

  it('does not drain children when the subclass does not override', () => {
    interface FlatProps {
      readonly label: string;
    }
    class Flat extends AggregateRoot<FlatProps> {
      bump(): void {
        this.addDomainEvent(new Bumped(this.id, { by: 1 }));
      }
    }
    const flat = new Flat({ label: 'x' }, 'f-1');
    flat.bump();
    expect(flat.drainDomainEvents()).toHaveLength(1);
  });
});
