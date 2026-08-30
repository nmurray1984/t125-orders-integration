#!/usr/bin/env python3
"""
Generate the fixtures the Worker's parser is tested against.

The modifier-parsing logic was written and debugged in Python. When it moved
into the Worker, the safest way to know the port is faithful was to freeze the
Python implementation's output and assert the JavaScript reproduces it exactly.

    python scripts/make_worker_fixture.py

Writes worker/test/fixtures/square-api.json (input, in Square REST shape) and
worker/test/fixtures/expected-rows.json (what the Python parser produces).
Re-run it if the parsing rules ever change on purpose.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import square_orders
from mock_square_data import (
    mock_catalog_modifiers_response,
    mock_catalog_modifiers_with_list_response,
    mock_catalog_modifier_lists_response,
    mock_orders_response,
    mock_orders_with_modifier_lists_response,
    mock_refunded_order,
)

FIXTURE_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'worker', 'test', 'fixtures',
)


def money_json(money):
    return None if money is None else {'amount': money.amount, 'currency': money.currency}


def order_json(order):
    return {
        'id': order.id,
        'created_at': order.created_at,
        'total_money': money_json(order.total_money),
        'line_items': [
            {
                'uid': item.uid,
                'name': item.name,
                'catalog_object_id': item.catalog_object_id,
                'catalog_version': item.catalog_version,
                'variation_name': item.variation_name,
                'modifiers': [
                    {'uid': m.uid, 'name': m.name, 'catalog_object_id': m.catalog_object_id}
                    for m in item.modifiers
                ],
            }
            for item in order.line_items
        ],
    }


def catalog_json(obj):
    out = {'id': obj.id, 'type': obj.type, 'version': obj.version}
    if obj.modifier_data:
        out['modifier_data'] = {'name': obj.modifier_data.name}
        if obj.modifier_data.modifier_list_id:
            out['modifier_data']['modifier_list_id'] = obj.modifier_data.modifier_list_id
    if obj.modifier_list_data:
        out['modifier_list_data'] = {'name': obj.modifier_list_data.name}
    return out


def main():
    orders = (list(mock_orders_response.orders)
              + list(mock_orders_with_modifier_lists_response.orders)
              + [mock_refunded_order])

    modifiers = (list(mock_catalog_modifiers_response.objects)
                 + list(mock_catalog_modifiers_with_list_response.objects))
    modifier_lists = list(mock_catalog_modifier_lists_response.objects)

    modifier_details = {obj.id: obj for obj in modifiers}
    list_details = {obj.id: obj for obj in modifier_lists}

    # extract_order_data fetches modifier lists through the API; serve them
    # from the mock instead so this runs offline.
    square_orders.get_modifier_list_details = lambda requested: {
        item['object_id']: list_details[item['object_id']]
        for item in requested if item['object_id'] in list_details
    }

    rows = square_orders.extract_order_data(orders, modifier_details)

    os.makedirs(FIXTURE_DIR, exist_ok=True)

    api_path = os.path.join(FIXTURE_DIR, 'square-api.json')
    with open(api_path, 'w') as handle:
        json.dump({
            'orders': [order_json(o) for o in orders],
            'catalog_objects': [catalog_json(o) for o in modifiers + modifier_lists],
        }, handle, indent=2, sort_keys=True)
        handle.write('\n')

    rows_path = os.path.join(FIXTURE_DIR, 'expected-rows.json')
    with open(rows_path, 'w') as handle:
        json.dump(rows, handle, indent=2, sort_keys=True)
        handle.write('\n')

    print(f"Wrote {len(rows)} expected row(s) from {len(orders)} order(s)")
    print(f"  {api_path}")
    print(f"  {rows_path}")


if __name__ == '__main__':
    main()
