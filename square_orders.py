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
        print(f"Error fetching orders: {e}")
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
        
        if hasattr(order, 'line_items') and order.line_items:
            for line_item in order.line_items:
                line_item_name = line_item.name
                
                # Initialize row. line_item_uid makes (order_id, line_item_uid)
                # unique: one order can register several people.
                row = {
                    'order_id': order_id,
                    'line_item_uid': getattr(line_item, 'uid', '') or '',
                    'order_created_at': order_created_at,
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
    headers = ['Order ID', 'Total Money', 'Line Item Name', 'Name', 'Rank', 'Patrol',
               'Emergency Contact', 'Emergency Contact Phone', 'Cell Phone', 'Travel to Campout']

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
            'Total Money': row['total_money'],
            'Line Item Name': row['line_item_name'],
            'Name': name,
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
        description='Fetch Square orders and output to CSV or Google Sheets'
    )
    parser.add_argument(
        '--square-env',
        choices=['sandbox', 'production'],
        default=Config.SQUARE_ENVIRONMENT,
        help='Which Square environment to read from. Defaults to SQUARE_ENVIRONMENT, '
             'or sandbox when that is unset -- production is always deliberate.'
    )
    parser.add_argument(
        '--output',
        choices=['stdout', 'sheets', 'd1', 'both'],
        default='stdout',
        help='Output mode: stdout (CSV to console), sheets (Google Sheets), '
             'd1 (Cloudflare D1 via the roster Worker), or both (sheets + d1)'
    )
    args = parser.parse_args()

    # Validate configuration based on output mode
    if args.output in ('sheets', 'both'):
        Config.validate_google_sheets_config()
    if args.output in ('d1', 'both'):
        Config.validate_d1_config()

    token, location_id, source = Config.validate_square_config(args.square_env)
    configure_square(args.square_env, token, location_id)

    # Say which environment out loud. Confusing the two is the whole risk here.
    print(f"Square environment: {args.square_env} "
          f"(token from {source}, location {location_id})", file=sys.stderr)

    # Sandbox registrations are fake. Letting them into the deployed roster
    # would mix invented scouts in with real ones.
    if (args.square_env == 'sandbox'
            and args.output in ('d1', 'both')
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

    # Output based on mode. 'both' writes to Sheets and D1 so the two can run
    # side by side during the migration; a failure in either is fatal.
    failed = False

    if args.output == 'stdout':
        write_csv_to_stdout(order_data)

    if args.output in ('sheets', 'both'):
        from google_sheets import write_to_google_sheet, log_last_update
        if write_to_google_sheet(order_data):
            log_last_update()
        else:
            failed = True

    if args.output in ('d1', 'both'):
        from d1_sync import sync_to_d1
        if not sync_to_d1(order_data):
            failed = True

    if failed:
        sys.exit(1)

if __name__ == "__main__":
    main()
