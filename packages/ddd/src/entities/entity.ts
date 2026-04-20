import { randomUUID } from 'node:crypto';

export type EntityId = string;

export type BaseEntityProps = {
  readonly id?: EntityId;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly insertedBy?: string;
  readonly updatedBy?: string;
};

export abstract class Entity<TProps extends object = object> {
  readonly id: EntityId;
  protected readonly props: TProps & BaseEntityProps;

  constructor(props: TProps & BaseEntityProps, id?: EntityId) {
    this.props = props;
    this.id = id ?? props.id ?? randomUUID();
  }

  get createdAt(): Date | undefined {
    return this.props.createdAt;
  }

  get updatedAt(): Date | undefined {
    return this.props.updatedAt;
  }

  get insertedBy(): string | undefined {
    return this.props.insertedBy;
  }

  get updatedBy(): string | undefined {
    return this.props.updatedBy;
  }

  equals(other: Entity<TProps>): boolean {
    return this.id === other.id;
  }
}
