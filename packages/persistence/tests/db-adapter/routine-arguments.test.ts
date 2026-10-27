import { describe, expect, it } from 'vitest';
import { routineOutputNames } from '../../src/db-adapter/routine-arguments.js';

describe('routineOutputNames', () => {
  it('returns out and inout names in declaration order', () => {
    expect(
      routineOutputNames({
        routine: 'r',
        args: [
          { value: 1 },
          { name: 'a', mode: 'out' },
          { name: 'b', value: 2 },
          { name: 'c', mode: 'inout', value: 3 },
        ],
      }),
    ).toEqual(['a', 'c']);
  });

  it('returns no names for a call without arguments', () => {
    expect(routineOutputNames({ routine: 'r' })).toEqual([]);
  });

  it('requires out and inout arguments to be named', () => {
    expect(() => routineOutputNames({ routine: 'r', args: [{ mode: 'out' }] })).toThrow(
      'Routine "r": out arguments must be named.',
    );
    expect(() => routineOutputNames({ routine: 'r', args: [{ mode: 'inout', value: 1 }] })).toThrow(
      /inout arguments must be named/,
    );
  });

  it('rejects positional arguments after named ones', () => {
    expect(() =>
      routineOutputNames({ routine: 'r', args: [{ name: 'a', value: 1 }, { value: 2 }] }),
    ).toThrow(/positional arguments must precede named ones/);
  });

  it('rejects duplicate argument names', () => {
    expect(() =>
      routineOutputNames({
        routine: 'r',
        args: [
          { name: 'a', value: 1 },
          { name: 'a', mode: 'out' },
        ],
      }),
    ).toThrow(/duplicate argument "a"/);
  });
});
