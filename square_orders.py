import csv
import sys
import argparse
from square import Square
from square.environment import SquareEnvironment
from collections import defaultdict
from config import Config

FETCH_LIMIT = Config.SQUARE_FETCH_LIMIT

# The Square client is built lazily so --square-env can choose the environment
# before anything talks to Square. Nothing here should ever reach production
# just because a module got imported.
_client = None
_location_id = None

ENVIRONMENTS = {
    'sandbox': SquareEnvironment.SANDBOX,
    'production': SquareEnvironment.PRODUCTION,
}


def configure_square(environment, token, location_id):
    """Point this module at a Square environment. Returns the client."""
    global _client, _location_id
    _client = Square(environment=ENVIRONMENTS[environment], token=token)
    _location_id = location_id
    return _client


def get_client():
    """The configured Square client, defaulting to sandbox if never configured."""
    if _client is None:
        environment = Config.SQUARE_ENVIRONMENT
        token, location_id, _ = Config.square_credentials(environment)
        return configure_square(environment, token, location_id)
    return _client


def get_location_id():
    return _location_id if _location_id is not None else Config.SQUARE_LOCATION_ID


# Square puts the buyer's email in different places depending on how the order
# was created, so check each fulfillment's recipient in turn. Orders that carry
# only a customer_id need a separate Customers lookup, which the Worker does.
FULFILLMENT_DETAIL_FIELDS = ('pickup_details', 'shipment_details', 'delivery_details')


def extract_order_email(order):
    """Best available email for whoever placed the order, or ''."""
    for fulfillment in getattr(order, 'fulfillments', None) or []:
        for field in FULFILLMENT_DETAIL_FIELDS:
            details = getattr(fulfillment, field, None)
            recipient = getattr(details, 'recipient', None) if details else None
            email = getattr(recipient, 'email_address', None) if recipient else None
            if email:
                return email
    return ''


# Deciding whether an order was actually paid for.
#
# Square creates the Order when the buyer reaches checkout, not when they pay.
# Abandon the payment page and the order still exists, still carries every
# registration answer the buyer typed, and still comes back from SearchOrders,
# which only excludes DRAFT orders unless a state filter says otherwise. This
# is the JavaScript worker/src/payments.js logic; the two are pinned together
# by the parser fixtures.
#
# The bias is deliberate: only say UNPAID when the order positively says so. An
# order carrying no payment information at all is left unknown, and readers
# treat unknown as visible -- hiding a real registration is a far worse failure
# than showing an abandoned one.
PAID = 'PAID'
UNPAID = 'UNPAID'
CANCELED = 'CANCELED'
UNKNOWN = ''

# Statuses a payment can carry without any money having moved.
DEAD_TENDER_STATES = {'VOIDED', 'FAILED'}


def _has_live_tender(order):
    """True when the order carries a tender that was not voided or failed."""
    for tender in getattr(order, 'tenders', None) or []:
        card_details = getattr(tender, 'card_details', None)
        status = getattr(card_details, 'status', None) if card_details else None
        if not status or status not in DEAD_TENDER_STATES:
            return True
    return False


def _money_amount(money):
    amount = getattr(money, 'amount', None) if money is not None else None
    return amount if isinstance(amount, int) else None


def payment_status(order):
    """
    PAID, UNPAID, CANCELED, or '' when the order says nothing either way.

    Checked in order of how directly each signal reports money: a tender is a
    payment attached to this order, the amount still due is Square's own
    arithmetic over those tenders, and the state is a summary that lags both --
    a paid order can sit in OPEN until it is fulfilled.
    """
    if order is None:
        return UNKNOWN

    state = getattr(order, 'state', None)
    if state == 'CANCELED':
        return CANCELED

    if _has_live_tender(order):
        return PAID

    due = _money_amount(getattr(order, 'net_amount_due_money', None))
    if due is not None:
        return PAID if due == 0 else UNPAID

    if state == 'COMPLETED':
        return PAID
    if state in ('OPEN', 'DRAFT'):
        return UNPAID

    return UNKNOWN


# Square hands out several credential types that all look like opaque strings.
# Pasting the wrong one is the most common cause of a 401, and the prefix gives
# it away without us ever printing the secret.
WRONG_CREDENTIAL_PREFIXES = {
    'sq0idp-': 'a production Application ID',
    'sandbox-sq0idb-': 'a sandbox Application ID',
    'sq0csp-': 'an OAuth Application Secret',
}


def describe_token(token):
    """Describe a token well enough to debug it, without revealing it."""
    if not token:
        return 'empty'

    for prefix, what in WRONG_CREDENTIAL_PREFIXES.items():
        if token.startswith(prefix):
            return f"looks like {what}, not an Access Token (starts '{prefix}')"

    if token != token.strip():
        return 'has leading or trailing whitespace -- check for a stray space or newline'
    if token.startswith(('"', "'")):
        return 'starts with a quote -- .env values should not be quoted'
    if not token.startswith('EAAA'):
        return f"unexpected format (starts '{token[:4]}...'); Square Access Tokens start 'EAAA'"

    return f"looks like an Access Token ({len(token)} chars)"


def describe_api_error(exc):
    """Summarize a Square API error without dumping every response header."""
    status = getattr(exc, 'status_code', None)
    body = getattr(exc, 'body', None)

    details = []
    if isinstance(body, dict):
        for error in body.get('errors', []):
            part = error.get('detail') or error.get('code') or ''
            if part:
                details.append(part)

    summary = '; '.join(details) or str(exc)
    return f"HTTP {status}: {summary}" if status else summary


def check_credentials(environment, token, location_id):
    """
    Ask Square which locations this token can see.

    Answers the two questions a 401 leaves open: is the token valid, and does
    the location actually belong to it. Returns True when both hold.
    """
    print(f"Token: {describe_token(token)}", file=sys.stderr)

    try:
        result = get_client().locations.list()
    except Exception as exc:
        print(f"Could not list locations: {describe_api_error(exc)}", file=sys.stderr)
        print(
            f"\nThe {environment} Access Token was rejected. In the Square "
            f"Developer Dashboard, open your application, switch to the "
            f"{environment.title()} tab, and copy the {environment.title()} "
            f"*Access Token* -- not the Application ID.",
            file=sys.stderr,
        )
        return False

    locations = getattr(result, 'locations', None) or []
    if not locations:
        print("Token is valid but can see no locations.", file=sys.stderr)
        return False

    print(f"\nLocations visible to this token ({len(locations)}):", file=sys.stderr)
    matched = False
    for location in locations:
        marker = ' <-- configured' if location.id == location_id else ''
        print(f"  {location.id}  {getattr(location, 'name', '')}{marker}", file=sys.stderr)
        if location.id == location_id:
            matched = True

    if not matched:
        location_var = ('SQUARE_SANDBOX_LOCATION_ID' if environment == 'sandbox'
                        else 'SQUARE_LOCATION_ID')
        print(
            f"\nConfigured location {location_id} is not in that list. "
            f"Set {location_var} to one of the IDs above.",
            file=sys.stderr,
        )
        return False

    print("\nCredentials look good.", file=sys.stderr)
    return True

def extract_modifier_list_ids(orders):
    """Extract modifier list IDs from orders"""
    modifier_list_ids = []
    catalog_versions = defaultdict(list)
    
    for order in orders:
        if hasattr(order, 'line_items') and order.line_items:
            for line_item in order.line_items:
                if hasattr(line_item, 'modifiers') and line_item.modifiers:
                    for modifier in line_item.modifiers:
                        if hasattr(modifier, 'catalog_object_id') and modifier.catalog_object_id:
                            catalog_versions[line_item.catalog_version].append(modifier.catalog_object_id)
    
    return dict(catalog_versions)

def get_modifier_details(catalog_versions_dict):
    """Get modifier details from Square API for each catalog version"""
    modifier_details = {}
    
    for catalog_version, object_ids in catalog_versions_dict.items(): 
        # Remove duplicates while preserving order
        unique_object_ids = list(dict.fromkeys(object_ids))
        
        try:
            result = get_client().catalog.batch_get(
                object_ids=unique_object_ids,
                catalog_version=catalog_version
            )
            
            if hasattr(result, 'errors') and result.errors:
                print(f"API returned errors for catalog version {catalog_version}: {result.errors}")
            
            if hasattr(result, 'objects') and result.objects:
                for obj in result.objects:
                    if hasattr(obj, 'id') and obj.id:
                        modifier_details[obj.id] = obj
                        
        except Exception as e:
            print(f"Error fetching modifier details for catalog version {catalog_version}: {e}")
    
    return modifier_details

def get_modifier_list_details(modifier_list_ids):
    """Get modifier list details from Square API"""
    modifier_list_details = {}
    
    if not modifier_list_ids:
        return modifier_list_details
    
    # Group object IDs by catalog version
    catalog_versions = defaultdict(list)
    for item in modifier_list_ids:
        catalog_versions[item['catalog_version']].append(item['object_id'])
    
    # Make separate API calls for each catalog version
    for catalog_version, object_ids in catalog_versions.items():
        try:
            result = get_client().catalog.batch_get(
                object_ids=object_ids,
                catalog_version=catalog_version
            )
            
            if hasattr(result, 'errors') and result.errors:
                print(f"API returned errors for catalog version {catalog_version}: {result.errors}")
            
            if hasattr(result, 'objects') and result.objects:
                for obj in result.objects:
                    if hasattr(obj, 'id') and obj.id:
                        modifier_list_details[obj.id] = obj
                        
        except Exception as e:
            print(f"Error fetching modifier list details for catalog version {catalog_version}: {e}")
    
    return modifier_list_details

def get_recent_orders():
    """Fetch the most recent orders from Square API"""
    try:
        result = get_client().orders.search(
            location_ids=[get_location_id()],
            limit=FETCH_LIMIT
        )
        if hasattr(result, 'errors') and result.errors:
            print(f"API returned errors: {result.errors}")
        return result.orders if hasattr(result, 'orders') and result.orders else []
    except Exception as e:
        print(f"Error fetching orders: {describe_api_error(e)}", file=sys.stderr)
        if getattr(e, 'status_code', None) in (401, 403):
            print("Run with --check to see which credentials Square accepted.",
                  file=sys.stderr)
        return []

def extract_order_data(orders, modifier_details):
    """Extract order data into a structured format for table creation"""
    order_data = []
    
    for order in orders:
        order_id = order.id
        if order.total_money:
            total_money = f"{order.total_money.amount} {order.total_money.currency}"
        else:
            total_money = "0 USD"

        # Square returns an RFC3339 string; normalize to str so it survives JSON encoding
        order_created_at = getattr(order, 'created_at', None) or ''
        if order_created_at and not isinstance(order_created_at, str):
            order_created_at = str(order_created_at)

        email = extract_order_email(order)
        customer_id = getattr(order, 'customer_id', None) or ''
        # Whether the buyer paid is a property of the order, so every line item
        # on it inherits the same answer.
        order_payment_status = payment_status(order)
        
        if hasattr(order, 'line_items') and order.line_items:
            for line_item in order.line_items:
                line_item_name = line_item.name
                
                # Initialize row. line_item_uid makes (order_id, line_item_uid)
                # unique: one order can register several people.
                row = {
                    'order_id': order_id,
                    'line_item_uid': getattr(line_item, 'uid', '') or '',
                    'order_created_at': order_created_at,
                    'payment_status': order_payment_status,
                    'email': email,
                    'customer_id': customer_id,
                    'total_money': total_money,
                    'line_item_name': line_item_name,
                    'variation_name': getattr(line_item, 'variation_name', '') or '',
                    'scout_name': '',
                    'scouter_name': '',
                    'rank': '',
                    'patrol': '',
                    'emergency_contact': '',
                    'emergency_contact_phone': '',
                    'cell_phone': '',
                    'travel_to_campout': ''
                }
                
                # Extract modifier information
                if hasattr(line_item, 'modifiers') and line_item.modifiers:
                    for modifier in line_item.modifiers:
                        modifier_name = modifier.name
                        if modifier.catalog_object_id in modifier_details:
                            obj = modifier_details[modifier.catalog_object_id]
                            if hasattr(obj, 'modifier_data') and hasattr(obj.modifier_data, 'name'):
                                modifier_name = obj.modifier_data.name
                        
                        # Check if modifier has modifier_list_id
                        has_modifier_list = (
                            modifier.catalog_object_id in modifier_details and
                            hasattr(modifier_details[modifier.catalog_object_id], 'modifier_data') and
                            hasattr(modifier_details[modifier.catalog_object_id].modifier_data, 'modifier_list_id') and
                            modifier_details[modifier.catalog_object_id].modifier_data.modifier_list_id
                        )
                        
                        if has_modifier_list:
                            obj = modifier_details[modifier.catalog_object_id]
                            modifier_list_id = obj.modifier_data.modifier_list_id
                            # Get modifier list details
                            modifier_list_details = get_modifier_list_details([{
                                'catalog_version': line_item.catalog_version,
                                'object_id': modifier_list_id
                            }])
                            
                            if modifier_list_id in modifier_list_details:
                                modifier_list_obj = modifier_list_details[modifier_list_id]
                                if hasattr(modifier_list_obj, 'modifier_list_data') and hasattr(modifier_list_obj.modifier_list_data, 'name'):
                                    modifier_list_name = modifier_list_obj.modifier_list_data.name
                                    # Split modifier list name into key and value if it contains ":"
                                    if ":" in modifier_list_name:
                                        key, value = modifier_list_name.split(":", 1)
                                        key = key.strip()
                                        value = value.strip()
                                        # If modifier name is not already in the value, append it
                                        if modifier_name not in value:
                                            combined_value = f"{value} - {modifier_name}"
                                        else:
                                            combined_value = value
                                    else:
                                        # If no colon in modifier list name, treat it as key and modifier name as value
                                        key = modifier_list_name
                                        combined_value = modifier_name
                                    
                                    # Map the key to the appropriate column
                                    if key == "Scout Name":
                                        row['scout_name'] = combined_value
                                    elif key == "Scouter Name":
                                        row['scouter_name'] = combined_value
                                    elif key == "Rank":
                                        row['rank'] = combined_value
                                    elif key == "Patrol":
                                        row['patrol'] = combined_value
                                    elif key == "Emergency Contact":
                                        row['emergency_contact'] = combined_value
                                    elif key == "Emergency Contact Phone Number":
                                        row['emergency_contact_phone'] = combined_value
                                    elif key == "Cell phone number":
                                        row['cell_phone'] = combined_value
                                    elif key == "Will you travel with the troop to the campout?":
                                        row['travel_to_campout'] = combined_value
                        
                        else:
                            # For modifiers without modifier list, split modifier name into key and value if it contains ":"
                            if ":" in modifier_name:
                                key, value = modifier_name.split(":", 1)
                                key = key.strip()
                                value = value.strip()
                                
                                # Map the key to the appropriate column
                                if key == "Scout Name":
                                    row['scout_name'] = value
                                elif key == "Scouter Name":
                                    row['scouter_name'] = value
                                elif key == "Rank":
                                    row['rank'] = value
                                elif key == "Patrol":
                                    row['patrol'] = value
                                elif key == "Emergency Contact":
                                    row['emergency_contact'] = value
                                elif key == "Emergency Contact Phone Number":
                                    row['emergency_contact_phone'] = value
                                elif key == "Cell phone number":
                                    row['cell_phone'] = value
                                elif key == "Will you travel with the troop to the campout?":
                                    row['travel_to_campout'] = value
                            else:
                                # Handle modifiers without colons
                                if modifier_name == "Scout Name":
                                    row['scout_name'] = "Unknown"
                                elif modifier_name == "Scouter Name":
                                    row['scouter_name'] = "Unknown"
                                elif modifier_name == "Rank":
                                    row['rank'] = "Unknown"
                                elif modifier_name == "Patrol":
                                    row['patrol'] = "Unknown"
                                else:
                                    # For other modifiers, check if the modifier name itself contains a colon
                                    if ":" in modifier_name:
                                        key, value = modifier_name.split(":", 1)
                                        key = key.strip()
                                        value = value.strip()
                                        
                                        # Map the key to the appropriate column
                                        if key == "Scout Name":
                                            row['scout_name'] = value
                                        elif key == "Scouter Name":
                                            row['scouter_name'] = value
                                        elif key == "Rank":
                                            row['rank'] = value
                                        elif key == "Patrol":
                                            row['patrol'] = value
                                        elif key == "Emergency Contact":
                                            row['emergency_contact'] = value
                                        elif key == "Emergency Contact Phone Number":
                                            row['emergency_contact_phone'] = value
                                        elif key == "Cell phone number":
                                            row['cell_phone'] = value
                                        elif key == "Will you travel with the troop to the campout?":
                                            row['travel_to_campout'] = value
                
                order_data.append(row)
    
    return order_data

def write_csv_to_stdout(order_data):
    """Write order data as CSV to stdout"""
    if not order_data:
        print("No order data to write to CSV.")
        return

    # Define column headers with combined 'Name' column
    headers = ['Order ID', 'Ordered At', 'Total Money', 'Line Item Name', 'Name', 'Email',
               'Rank', 'Patrol', 'Emergency Contact', 'Emergency Contact Phone',
               'Cell Phone', 'Travel to Campout']

    # Create a CSV writer that writes to stdout
    writer = csv.DictWriter(sys.stdout, fieldnames=headers)

    # Write the header row
    writer.writeheader()

    # Write data rows
    for row in order_data:
        # Combine scout_name and scouter_name into a single Name field
        name = row['scout_name'] if row['scout_name'] else row['scouter_name']
        patrol = row['patrol'] if row['patrol'] else 'Rocking Chair'

        # Create a new dictionary with properly formatted keys
        csv_row = {
            'Order ID': row['order_id'],
            'Ordered At': row.get('order_created_at', ''),
            'Total Money': row['total_money'],
            'Line Item Name': row['line_item_name'],
            'Name': name,
            'Email': row.get('email', ''),
            'Rank': row['rank'],
            'Patrol': patrol,
            'Emergency Contact': row['emergency_contact'],
            'Emergency Contact Phone': row['emergency_contact_phone'],
            'Cell Phone': row['cell_phone'],
            'Travel to Campout': row['travel_to_campout']
        }
        writer.writerow(csv_row)

def main():
    """Main function to fetch and display recent orders with modifier details"""
    # Parse command line arguments
    parser = argparse.ArgumentParser(
        description='Fetch Square orders and print them, or push them to the roster Worker'
    )
    parser.add_argument(
        '--square-env',
        choices=['sandbox', 'production'],
        default=Config.SQUARE_ENVIRONMENT,
        help='Which Square environment to read from. Defaults to SQUARE_ENVIRONMENT, '
             'or sandbox when that is unset -- production is always deliberate.'
    )
    parser.add_argument(
        '--check',
        action='store_true',
        help='Verify the Square credentials and list the locations they can see, '
             'then exit without fetching orders.'
    )
    parser.add_argument(
        '--output',
        choices=['stdout', 'd1'],
        default='stdout',
        help='Output mode: stdout (CSV to console) or d1 (push to the roster '
             'Worker). The scheduled sync runs on Cloudflare Cron; this CLI is '
             'for inspecting Square data and for manual backfills.'
    )
    args = parser.parse_args()

    # Validate configuration based on output mode
    if args.output == 'd1':
        Config.validate_d1_config()

    token, location_id, source = Config.validate_square_config(args.square_env)
    configure_square(args.square_env, token, location_id)

    # Say which environment out loud. Confusing the two is the whole risk here.
    print(f"Square environment: {args.square_env} "
          f"(token from {source}, location {location_id})", file=sys.stderr)

    if args.check:
        sys.exit(0 if check_credentials(args.square_env, token, location_id) else 1)

    # Sandbox registrations are fake. Letting them into the deployed roster
    # would mix invented scouts in with real ones.
    if (args.square_env == 'sandbox'
            and args.output == 'd1'
            and not Config.is_local_sync_url()):
        print("WARNING: syncing SANDBOX data to a non-local D1 "
              f"({Config.D1_SYNC_URL}). Test data will land in the real roster.",
              file=sys.stderr)

    print("Fetching recent orders from Square API...", file=sys.stderr)
    orders = get_recent_orders()

    if not orders:
        print("No orders found.", file=sys.stderr)
        return

    # Extract modifier list IDs from orders
    catalog_versions_dict = extract_modifier_list_ids(orders)

    # Get modifier details
    modifier_details = get_modifier_details(catalog_versions_dict)

    print("\nOrder Details:", file=sys.stderr)
    print("-" * 50, file=sys.stderr)

    # Extract structured data for table
    order_data = extract_order_data(orders, modifier_details)

    if args.output == 'stdout':
        write_csv_to_stdout(order_data)
    elif args.output == 'd1':
        from d1_sync import sync_to_d1
        if not sync_to_d1(order_data):
            sys.exit(1)

if __name__ == "__main__":
    main()
