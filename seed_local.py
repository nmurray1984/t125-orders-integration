#!/usr/bin/env python3
"""
Seed the local Worker with fake registrations so you can click around the web
app without Square credentials.

    cd worker && npm run dev        # in one terminal
    python seed_local.py            # in another

Never point this at a deployed Worker -- it writes obviously fake people.
"""

import argparse
import json
from datetime import datetime, timedelta
import sys
import urllib.request

DEFAULT_URL = 'http://127.0.0.1:8787/api/sync'
DEFAULT_TOKEN = 'localdev-sync-token'

PATROLS = ['Eagle', 'Hawk', 'Cobra', 'Rocking Chair']
RANKS = ['Scout', 'Tenderfoot', 'Second Class', 'First Class', 'Star', 'Life', 'Eagle']

# Real Square catalog names: one campout is sold as several registration types
# (Scout, Scouter, sometimes Prospective), which is exactly what the campout
# setup page exists to group back together.
CAMPOUTS = [
    ('Scout Registration - May 2026', '2026-05-02T14:30:00Z', 8),
    ('Scouter Registration - May 2026', '2026-05-02T15:00:00Z', 4),
    ('Prospective Scout Registration - May 2026', '2026-05-03T09:00:00Z', 3),
    ('Scout Registration - Advancement Campout - Sept 2026', '2026-08-25T14:30:00Z', 5),
    ('Scouter Registration - Advancement Campout - Sept 2026', '2026-08-25T15:10:00Z', 3),
    ('Scout Registration - NASA Campout - Oct 2026', '2026-08-28T09:15:00Z', 6),
    ('Scouter Registration - NASA Campout - Oct 2026', '2026-08-28T10:05:00Z', 6),
]

FIRST = ['Avery', 'Blake', 'Casey', 'Devon', 'Emerson', 'Finley', 'Harper',
         'Jordan', 'Kai', 'Logan', 'Micah', 'Noel', 'Parker', 'Quinn', 'Riley']
LAST = ['Alvarez', 'Brooks', 'Chen', 'Delgado', 'Ellis', 'Foster', 'Grant',
        'Huang', 'Iverson', 'Jain', 'Kowalski', 'Lindqvist']


def build_rows():
    rows = []
    counter = 0
    for campout, created_at, headcount in CAMPOUTS:
        for i in range(headcount):
            counter += 1
            scout = f"{FIRST[counter % len(FIRST)]} {LAST[counter % len(LAST)]}"
            adult = i % 4 == 0
            # Stagger signups across days so the date sort is visible.
            ordered_at = (
                datetime.fromisoformat(created_at.replace('Z', '+00:00'))
                + timedelta(days=i % 5, hours=i % 7)
            ).strftime('%Y-%m-%dT%H:%M:%SZ')

            rows.append({
                'order_id': f'SEED_ORDER_{counter:03d}',
                'line_item_uid': f'SEED_ITEM_{counter:03d}',
                'campout': campout,
                'variation_name': 'Adult' if adult else 'Scout',
                'name': scout,
                'scout_name': '' if adult else scout,
                'scouter_name': scout if adult else '',
                'rank': '' if adult else RANKS[counter % len(RANKS)],
                'patrol': PATROLS[counter % len(PATROLS)],
                'emergency_contact': f"{FIRST[(counter + 5) % len(FIRST)]} {LAST[counter % len(LAST)]}",
                'emergency_contact_phone': f'555-01{counter:02d}',
                'cell_phone': f'555-02{counter:02d}' if counter % 3 else '',
                'travel_to_campout': 'Yes' if counter % 4 else 'No',
                'total_money': '2500 USD' if adult else '1500 USD',
                # Every twelfth one abandoned checkout, so the roster's
                # "started but never paid for" path is exercised locally.
                'payment_status': 'UNPAID' if counter % 12 == 0 else 'PAID',
                'order_created_at': ordered_at,
                # A few blanks, so the UI is exercised with missing emails too.
                'email': '' if counter % 7 == 0 else
                         f"{scout.lower().replace(' ', '.')}@example.com",
                'customer_id': f'CUST_{counter:03d}',
            })
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default=DEFAULT_URL)
    parser.add_argument('--token', default=DEFAULT_TOKEN)
    args = parser.parse_args()

    rows = build_rows()
    request = urllib.request.Request(
        args.url,
        data=json.dumps({'rows': rows, 'final': True}).encode(),
        headers={
            'Authorization': f'Bearer {args.token}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except Exception as exc:
        print(f"Could not reach the Worker at {args.url}: {exc}", file=sys.stderr)
        print("Is `npm run dev` running in the worker/ directory?", file=sys.stderr)
        return 1

    print(f"Seeded {result.get('upserted', 0)} registration(s) "
          f"across {len(CAMPOUTS)} campouts.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
