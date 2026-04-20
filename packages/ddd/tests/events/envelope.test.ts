import { describe, expect, it } from 'vitest';
import { DomainEvent } from '../../src/events/domain-event.js';
import { EnvelopedEvent } from '../../src/events/envelope.js';
import { EventKind, EventMetadata } from '../../src/events/event-metadata.js';

class Sample extends DomainEvent<{ n: number }> {}

describe('EnvelopedEvent', () => {
  it('binds an event to its metadata', () => {
    const evt = new Sample('agg-1', { n: 1 });
    const meta = EventMetadata.create({
      kind: EventKind.DOMAIN,
      correlationId: 'corr-1',
      actorType: 'user',
    });
    const envelope = new EnvelopedEvent(evt, meta);
    expect(envelope.event).toBe(evt);
    expect(envelope.metadata).toBe(meta);
  });
});
