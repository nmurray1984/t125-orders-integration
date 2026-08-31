"""
Push extracted Square order rows to the Cloudflare Worker, which upserts them
into D1.

The Square fetch is a rolling window of recent orders, so this sync is upsert
only -- it never deletes. That is what lets past campouts stay in the database
instead of scrolling off the end of the window the way they did in the sheet.
"""

import json
import sys
import time

import requests

from config import Config

BATCH_SIZE = 200
MAX_RETRIES = 4
REQUEST_TIMEOUT = 30


def build_row(row_data):
    """Map an extracted order row to the payload the Worker expects."""
    name = row_data.get('scout_name') or row_data.get('scouter_name') or ''
    patrol = row_data.get('patrol') or 'Rocking Chair'

    return {
        'order_id': row_data.get('order_id', ''),
        'line_item_uid': row_data.get('line_item_uid', ''),
        'campout': row_data.get('line_item_name', ''),
        'variation_name': row_data.get('variation_name', ''),
        'name': name,
        'scout_name': row_data.get('scout_name', ''),
        'scouter_name': row_data.get('scouter_name', ''),
        'rank': row_data.get('rank', ''),
        'patrol': patrol,
        'emergency_contact': row_data.get('emergency_contact', ''),
        'emergency_contact_phone': row_data.get('emergency_contact_phone', ''),
        'cell_phone': row_data.get('cell_phone', ''),
        'travel_to_campout': row_data.get('travel_to_campout', ''),
        'total_money': row_data.get('total_money', ''),
        # PAID / UNPAID / CANCELED, or '' when the order said nothing either
        # way. The Worker hides the unpaid ones from the roster rather than
        # dropping them, so a checkout paid for later can flip back.
        'payment_status': row_data.get('payment_status', ''),
        'order_created_at': row_data.get('order_created_at', ''),
        'email': row_data.get('email', ''),
        'customer_id': row_data.get('customer_id', ''),
    }


def build_rows(order_data):
    """Build payload rows, dropping any row without a usable primary key."""
    rows = []
    skipped = 0
    for row_data in order_data:
        row = build_row(row_data)
        if row['order_id'] and row['line_item_uid']:
            rows.append(row)
        else:
            skipped += 1

    if skipped:
        print(f"Skipped {skipped} row(s) missing order_id or line_item_uid", file=sys.stderr)

    return rows


def _post_batch(url, token, batch, is_final):
    """POST one batch, retrying transient failures with exponential backoff."""
    payload = {'rows': batch, 'final': is_final}
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json',
    }

    delay = 2
    last_error = None

    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = requests.post(
                url, headers=headers, data=json.dumps(payload), timeout=REQUEST_TIMEOUT
            )
        except requests.RequestException as exc:
            last_error = f"network error: {exc}"
        else:
            if response.ok:
                return response.json()

            # 4xx other than 429 means the request itself is wrong; retrying
            # will not help and would just hammer the Worker.
            if 400 <= response.status_code < 500 and response.status_code != 429:
                raise RuntimeError(
                    f"sync rejected ({response.status_code}): {response.text[:300]}"
                )
            last_error = f"HTTP {response.status_code}: {response.text[:300]}"

        if attempt < MAX_RETRIES:
            print(f"Sync attempt {attempt} failed ({last_error}); retrying in {delay}s",
                  file=sys.stderr)
            time.sleep(delay)
            delay *= 2

    raise RuntimeError(f"sync failed after {MAX_RETRIES} attempts: {last_error}")


def sync_to_d1(order_data, url=None, token=None):
    """
    Upsert order data into D1 via the Worker.

    Returns True on success, False on failure.
    """
    url = url or Config.D1_SYNC_URL
    token = token or Config.D1_SYNC_TOKEN

    rows = build_rows(order_data)
    if not rows:
        print("No rows to sync.", file=sys.stderr)
        return False

    batches = [rows[i:i + BATCH_SIZE] for i in range(0, len(rows), BATCH_SIZE)]
    total_upserted = 0

    try:
        for index, batch in enumerate(batches):
            is_final = index == len(batches) - 1
            result = _post_batch(url, token, batch, is_final)
            total_upserted += result.get('upserted', 0)
            print(
                f"Synced batch {index + 1}/{len(batches)}: "
                f"{result.get('upserted', 0)} row(s)",
                file=sys.stderr,
            )
    except (RuntimeError, ValueError) as exc:
        print(f"Error syncing to D1: {exc}", file=sys.stderr)
        return False

    print(f"Successfully synced {total_upserted} registration(s) to D1", file=sys.stderr)
    return True
