#!/usr/bin/env python3
"""
Show the shape of a Square orders response without printing anyone's details.

Pipe a raw /v2/orders/search response into it:

    curl ... | python3 scripts/inspect_order.py

It prints the JSON paths present and, for each, a redacted description of the
value -- so the structure can be shared while names, emails and phone numbers
stay on your machine. Paths whose value looks like an email are flagged.
"""

import json
import re
import sys

EMAIL = re.compile(r'^[^@\s]+@[^@\s]+\.[^@\s]+$')
PHONE = re.compile(r'^\+?[\d\-\(\)\s\.]{7,}$')


def describe(value):
    """A value's shape, never its content."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return f'bool({str(value).lower()})'
    if isinstance(value, (int, float)):
        return f'number({value})' if abs(value) < 10 else 'number'
    if not isinstance(value, str):
        return type(value).__name__

    if EMAIL.match(value):
        return f'EMAIL <-- ({len(value)} chars)'
    if PHONE.match(value.strip()):
        return 'phone-like'
    if re.match(r'^\d{4}-\d{2}-\d{2}T', value):
        return f'timestamp({value})'
    # Identifiers and enum-ish values are safe and useful to see verbatim.
    if re.match(r'^[A-Z0-9_]{2,40}$', value):
        return f'"{value}"'
    return f'string({len(value)} chars)'


def walk(node, path=''):
    if isinstance(node, dict):
        for key, value in node.items():
            yield from walk(value, f'{path}.{key}' if path else key)
    elif isinstance(node, list):
        if not node:
            yield f'{path}[]', 'empty list'
        else:
            # One representative element is enough to show the shape.
            yield from walk(node[0], f'{path}[0]')
    else:
        yield path, describe(node)


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f'Not JSON: {exc}', file=sys.stderr)
        return 1

    if 'errors' in payload:
        print('Square returned an error:')
        for error in payload['errors']:
            print(f"  {error.get('code')}: {error.get('detail')}")
        return 1

    orders = payload.get('orders') or []
    if not orders:
        print('No orders in the response. Nothing to inspect.')
        return 1

    print(f'{len(orders)} order(s) returned. Showing the shape of the first:\n')

    emails = []
    for path, shape in walk(orders[0]):
        marker = '  ' if 'EMAIL' not in shape else '> '
        print(f'{marker}{path}: {shape}')
        if 'EMAIL' in shape:
            emails.append(path)

    print()
    if emails:
        print('Email found at:')
        for path in emails:
            print(f'  {path}')
    else:
        print('No email-shaped value anywhere in this order.')
        keys = sorted(orders[0].keys())
        print(f'Top-level keys present: {", ".join(keys)}')
        if 'customer_id' in orders[0]:
            print('This order has a customer_id, so the email may only be '
                  'reachable via GET /v2/customers/{id}.')

    # Scan the rest too: not every order carries the same fields.
    others = set()
    for order in orders[1:]:
        for path, shape in walk(order):
            if 'EMAIL' in shape and path not in emails:
                others.add(path)
    if others:
        print('\nOther orders also have an email at:')
        for path in sorted(others):
            print(f'  {path}')


if __name__ == '__main__':
    sys.exit(main() or 0)
