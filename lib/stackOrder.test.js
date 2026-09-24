const { applyStackOrder } = require('./stackOrder');

const a = { id: 'a', albumName: 'A' };
const b = { id: 'b', albumName: 'B' };
const c = { id: 'c', albumName: 'C' };
const d = { id: 'd', albumName: 'D' };
const e = { id: 'e', albumName: 'E' };

describe('applyStackOrder', () => {
    it('reorders the full list', () => {
        expect(applyStackOrder([a, b, c], ['c', 'a', 'b'])).toEqual({ stack: [c, a, b] });
    });

    it('reorders a loaded prefix and leaves the unloaded tail untouched', () => {
        expect(applyStackOrder([a, b, c, d, e], ['b', 'a', 'c'])).toEqual({ stack: [b, a, c, d, e] });
    });

    it('refills only the slots held by a non-contiguous subset', () => {
        expect(applyStackOrder([a, b, c, d, e], ['d', 'b'])).toEqual({ stack: [a, d, c, b, e] });
    });

    it('returns missing ids and no stack when an id is not in the stack', () => {
        const mystack = [a, b, c];
        expect(applyStackOrder(mystack, ['b', 'z', 'a', 'y'])).toEqual({ missing: ['z', 'y'] });
        expect(mystack).toEqual([a, b, c]);
    });

    it('treats a single-id order as a no-op', () => {
        expect(applyStackOrder([a, b, c], ['b'])).toEqual({ stack: [a, b, c] });
    });

    it('does not mutate the input array', () => {
        const mystack = [a, b, c];
        applyStackOrder(mystack, ['c', 'b', 'a']);
        expect(mystack).toEqual([a, b, c]);
    });

    it('moves the original item objects rather than rebuilding them', () => {
        const { stack } = applyStackOrder([a, b], ['b', 'a']);
        expect(stack[0]).toBe(b);
        expect(stack[1]).toBe(a);
    });
});
