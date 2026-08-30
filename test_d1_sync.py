"""
Tests for the Cloudflare D1 sync path, using mock Square data and a stubbed
HTTP layer. No network calls, no live Worker.
"""

import json
import sys
import os
from unittest import mock

sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from mock_square_data import get_mock_orders_response
from square_orders import extract_order_data
import d1_sync


class FakeResponse:
    def __init__(self, status_code, payload=None, text=''):
        self.status_code = status_code
        self.ok = 200 <= status_code < 300
        self._payload = payload or {}
        self.text = text

    def json(self):
        return self._payload


def check(label, condition):
    print(f"{'✓' if condition else '✗'} {label}")
    return condition


def test_build_rows_maps_fields():
    """build_rows should produce the payload shape the Worker expects"""
    print("\nTesting build_rows field mapping...")
    order_data = extract_order_data(get_mock_orders_response().orders, {})
    rows = d1_sync.build_rows(order_data)

    results = [
        check("every row has a composite key",
              all(r['order_id'] and r['line_item_uid'] for r in rows)),
        check("campout comes from the line item name",
              all(r['campout'] == 'Camp Registration' for r in rows)),
        check("composite keys are unique",
              len({(r['order_id'], r['line_item_uid']) for r in rows}) == len(rows)),
        check("order_created_at is carried through",
              all(r['order_created_at'] for r in rows)),
    ]
    return all(results)


def test_name_and_patrol_defaults():
    """Name falls back to scouter_name; empty patrol defaults to Rocking Chair"""
    print("\nTesting name fallback and patrol default...")
    scouter_only = d1_sync.build_row({
        'order_id': 'O1', 'line_item_uid': 'L1',
        'scout_name': '', 'scouter_name': 'Bob Doe', 'patrol': '',
    })
    scout_wins = d1_sync.build_row({
        'order_id': 'O1', 'line_item_uid': 'L1',
        'scout_name': 'John Smith', 'scouter_name': 'Bob Doe', 'patrol': 'Eagle',
    })

    return all([
        check("falls back to scouter_name", scouter_only['name'] == 'Bob Doe'),
        check("empty patrol defaults to Rocking Chair",
              scouter_only['patrol'] == 'Rocking Chair'),
        check("scout_name takes priority", scout_wins['name'] == 'John Smith'),
        check("explicit patrol is preserved", scout_wins['patrol'] == 'Eagle'),
    ])


def test_rows_without_keys_are_dropped():
    """Rows missing order_id or line_item_uid cannot be upserted, so drop them"""
    print("\nTesting rows without a primary key are dropped...")
    rows = d1_sync.build_rows([
        {'order_id': 'O1', 'line_item_uid': 'L1', 'scout_name': 'Keep Me'},
        {'order_id': 'O2', 'line_item_uid': '', 'scout_name': 'No UID'},
        {'order_id': '', 'line_item_uid': 'L3', 'scout_name': 'No Order'},
    ])
    return all([
        check("only the complete row survives", len(rows) == 1),
        check("the surviving row is the right one", rows[0]['name'] == 'Keep Me'),
    ])


def test_batching():
    """Rows are split into batches and only the last one is marked final"""
    print("\nTesting batching...")
    order_data = [
        {'order_id': f'O{i}', 'line_item_uid': f'L{i}', 'scout_name': f'Scout {i}'}
        for i in range(450)
    ]

    with mock.patch.object(d1_sync.requests, 'post') as post:
        post.return_value = FakeResponse(200, {'ok': True, 'upserted': 200})
        ok = d1_sync.sync_to_d1(order_data, url='https://example.test/api/sync', token='t')

    bodies = [json.loads(call.kwargs['data']) for call in post.call_args_list]

    return all([
        check("sync reports success", ok),
        check("450 rows split into 3 batches of <=200", len(bodies) == 3),
        check("batch sizes are 200/200/50",
              [len(b['rows']) for b in bodies] == [200, 200, 50]),
        check("only the last batch is final",
              [b['final'] for b in bodies] == [False, False, True]),
        check("bearer token is sent",
              all(call.kwargs['headers']['Authorization'] == 'Bearer t'
                  for call in post.call_args_list)),
    ])


def test_client_error_is_not_retried():
    """A 4xx means the request is wrong; retrying would just hammer the Worker"""
    print("\nTesting 4xx is not retried...")
    rows = [{'order_id': 'O1', 'line_item_uid': 'L1', 'scout_name': 'A'}]

    with mock.patch.object(d1_sync.requests, 'post') as post:
        post.return_value = FakeResponse(401, text='unauthorized')
        ok = d1_sync.sync_to_d1(rows, url='https://example.test/api/sync', token='bad')

    return all([
        check("sync reports failure", ok is False),
        check("only one attempt was made", post.call_count == 1),
    ])


def test_server_error_is_retried():
    """A 5xx is transient, so it should be retried before giving up"""
    print("\nTesting 5xx is retried then succeeds...")
    rows = [{'order_id': 'O1', 'line_item_uid': 'L1', 'scout_name': 'A'}]

    with mock.patch.object(d1_sync.requests, 'post') as post, \
            mock.patch.object(d1_sync.time, 'sleep'):
        post.side_effect = [
            FakeResponse(500, text='boom'),
            FakeResponse(200, {'ok': True, 'upserted': 1}),
        ]
        ok = d1_sync.sync_to_d1(rows, url='https://example.test/api/sync', token='t')

    return all([
        check("sync eventually succeeds", ok),
        check("it retried once", post.call_count == 2),
    ])


def test_sync_url_validation():
    """http is allowed only for a Worker on this machine"""
    print("\nTesting D1_SYNC_URL host rules...")
    from config import Config

    accepted = lambda url: url.startswith('https://') or Config.is_local_sync_url(url)

    return all([
        check("https anywhere is fine",
              accepted('https://t125-roster.example.workers.dev/api/sync')),
        check("http on 127.0.0.1 is allowed", accepted('http://127.0.0.1:8787/api/sync')),
        check("http on localhost is allowed", accepted('http://localhost:8787/api/sync')),
        check("http on ::1 is allowed", accepted('http://[::1]:8787/api/sync')),
        check("http on a remote host is refused", not accepted('http://example.com/api/sync')),
        check("a lookalike host is refused",
              not accepted('http://127.0.0.1.evil.test/api/sync')),
        check("localhost in the query string is refused",
              not accepted('http://evil.test/?x=127.0.0.1')),
    ])


def test_square_environment_selection():
    """The flag must actually change the Square host, not just the label"""
    print("\nTesting Square environment selection...")
    from square_orders import configure_square
    from config import Config

    sandbox = configure_square('sandbox', 'tok', 'LOC')._client_wrapper.get_base_url()
    production = configure_square('production', 'tok', 'LOC')._client_wrapper.get_base_url()

    results = [
        check("sandbox points at squareupsandbox.com", 'squareupsandbox.com' in sandbox),
        check("production points at squareup.com",
              'squareup.com' in production and 'sandbox' not in production),
        check("the two differ", sandbox != production),
    ]

    # Credential resolution: sandbox vars win when set, generic ones are the
    # fallback so sandbox-only credentials still work in SQUARE_ACCESS_TOKEN.
    original = (Config.SQUARE_ACCESS_TOKEN, Config.SQUARE_LOCATION_ID,
                Config.SQUARE_SANDBOX_ACCESS_TOKEN, Config.SQUARE_SANDBOX_LOCATION_ID)
    try:
        Config.SQUARE_ACCESS_TOKEN = 'prod-token'
        Config.SQUARE_LOCATION_ID = 'PRODLOC'
        Config.SQUARE_SANDBOX_ACCESS_TOKEN = 'sandbox-token'
        Config.SQUARE_SANDBOX_LOCATION_ID = 'SBLOC'

        token, location, _ = Config.square_credentials('sandbox')
        results.append(check("sandbox uses the sandbox credentials",
                             (token, location) == ('sandbox-token', 'SBLOC')))

        token, location, _ = Config.square_credentials('production')
        results.append(check("production uses the production credentials",
                             (token, location) == ('prod-token', 'PRODLOC')))

        Config.SQUARE_SANDBOX_ACCESS_TOKEN = ''
        Config.SQUARE_SANDBOX_LOCATION_ID = ''
        token, location, source = Config.square_credentials('sandbox')
        results.append(check("sandbox falls back to the generic vars when unset",
                             (token, location, source) ==
                             ('prod-token', 'PRODLOC', 'SQUARE_ACCESS_TOKEN')))
    finally:
        (Config.SQUARE_ACCESS_TOKEN, Config.SQUARE_LOCATION_ID,
         Config.SQUARE_SANDBOX_ACCESS_TOKEN, Config.SQUARE_SANDBOX_LOCATION_ID) = original

    return all(results)


def test_token_description():
    """Token diagnostics must name the problem without revealing the secret"""
    print("\nTesting credential diagnostics...")
    from square_orders import describe_token, describe_api_error

    secret = 'EAAAsupersecrettokenvalue1234567890'
    described = describe_token(secret)

    results = [
        check("a plausible token is accepted", 'Access Token' in described),
        check("the token itself is never echoed", secret not in described),
        check("a sandbox Application ID is called out",
              'Application ID' in describe_token('sandbox-sq0idb-abc')),
        check("a production Application ID is called out",
              'Application ID' in describe_token('sq0idp-abc')),
        check("an OAuth secret is called out",
              'Secret' in describe_token('sq0csp-abc')),
        check("stray whitespace is called out",
              'whitespace' in describe_token(' EAAAtoken ')),
        check("a quoted value is called out",
              'quote' in describe_token('"EAAAtoken"')),
        check("an empty token is called out", describe_token('') == 'empty'),
    ]

    class FakeError(Exception):
        status_code = 401
        body = {'errors': [{'category': 'AUTHENTICATION_ERROR',
                            'code': 'UNAUTHORIZED',
                            'detail': 'This request could not be authorized.'}]}

    summary = describe_api_error(FakeError())
    results.append(check("API errors summarize status and detail",
                         summary == 'HTTP 401: This request could not be authorized.'))
    results.append(check("API errors do not dump headers", 'cf-ray' not in summary))

    return all(results)


def test_square_calls_are_read_only():
    """The CLI must never call a Square method that changes seller data"""
    print("\nTesting the CLI only reads from Square...")
    import re

    source = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                               'square_orders.py')).read()

    # Every Square SDK call, e.g. get_client().orders.search(
    calls = set(re.findall(r'get_client\(\)\.([a-z_]+\.[a-z_]+)\(', source))

    allowed = {
        'orders.search',        # read: recent orders
        'catalog.batch_get',    # read: modifier + modifier list objects
        'locations.list',       # read: locations this token can see
    }

    forbidden = re.findall(
        r'get_client\(\)\.[a-z_]+\.(create|update|delete|upsert|pay|refund|cancel)',
        source)

    return all([
        check(f"only known read calls are made ({', '.join(sorted(calls))})",
              calls <= allowed),
        check("no create/update/delete/pay/refund calls", not forbidden),
        check("all three reads are still present", calls == allowed),
    ])


def main():
    print("Running D1 sync tests...")
    print("=" * 60)

    results = [
        test_build_rows_maps_fields(),
        test_name_and_patrol_defaults(),
        test_rows_without_keys_are_dropped(),
        test_batching(),
        test_client_error_is_not_retried(),
        test_server_error_is_retried(),
        test_sync_url_validation(),
        test_square_environment_selection(),
        test_token_description(),
        test_square_calls_are_read_only(),
    ]

    print("\n" + "=" * 60)
    print(f"Passed: {sum(results)}/{len(results)}")
    if all(results):
        print("✓ All D1 sync tests passed!")
    else:
        print("✗ Some D1 sync tests failed.")
    return all(results)


if __name__ == "__main__":
    sys.exit(0 if main() else 1)
