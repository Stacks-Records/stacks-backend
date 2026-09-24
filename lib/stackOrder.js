// Applies a manual (drag-and-drop) reorder to a user's mystack snapshots.
//
// `order` may be only a subset of the stack: the frontend infinite-scrolls, so it
// only ever sends the ids it has loaded. The positions those ids currently occupy
// are refilled in `order`'s sequence; every other item stays exactly where it is.
// Since unfiltered pages are always a prefix of the array, this just rewrites the
// loaded prefix and leaves the not-yet-loaded tail alone.
//
// Returns { stack } on success, or { missing } listing any ids not in the stack
// (e.g. the client's view is stale after a delete in another tab).
function applyStackOrder(mystack, order) {
    const byId = new Map(mystack.map(item => [item.id, item]));
    const missing = order.filter(id => !byId.has(id));
    if (missing.length) return { missing };

    const wanted = new Set(order);
    const slots = [];
    mystack.forEach((item, index) => {
        if (wanted.has(item.id)) slots.push(index);
    });

    const stack = [...mystack];
    slots.forEach((slot, k) => {
        stack[slot] = byId.get(order[k]);
    });
    return { stack };
}

module.exports = { applyStackOrder };
