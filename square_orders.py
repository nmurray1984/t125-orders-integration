from square import Square
from square.environment import SquareEnvironment
from collections import defaultdict

client = Square(
    environment=SquareEnvironment.PRODUCTION,
    token="***REMOVED***"
)

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
            result = client.catalog.batch_get(
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
            result = client.catalog.batch_get(
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
    """Fetch the 30 most recent orders from Square API"""
    try:
        result = client.orders.search(
            location_ids=["LRG8TDY17X9VD"],
            limit=20
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
        total_money = f"{order.total_money.amount} {order.total_money.currency}"
        
        if hasattr(order, 'line_items') and order.line_items:
            for line_item in order.line_items:
                line_item_name = line_item.name
                
                # Initialize row with basic info
                row = {
                    'order_id': order_id,
                    'total_money': total_money,
                    'line_item_name': line_item_name,
                    'scout_name': '',
                    'rank': '',
                    'patrol': '',
                    'emergency_contact': '',
                    'emergency_contact_phone': '',
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
                                    elif key == "Rank":
                                        row['rank'] = combined_value
                                    elif key == "Patrol":
                                        row['patrol'] = combined_value
                                    elif key == "Emergency Contact":
                                        row['emergency_contact'] = combined_value
                                    elif key == "Emergency Contact Phone Number":
                                        row['emergency_contact_phone'] = combined_value
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
                                elif key == "Rank":
                                    row['rank'] = value
                                elif key == "Patrol":
                                    row['patrol'] = value
                                elif key == "Emergency Contact":
                                    row['emergency_contact'] = value
                                elif key == "Emergency Contact Phone Number":
                                    row['emergency_contact_phone'] = value
                                elif key == "Will you travel with the troop to the campout?":
                                    row['travel_to_campout'] = value
                            else:
                                # Handle modifiers without colons
                                if modifier_name == "Scout Name":
                                    row['scout_name'] = "Unknown"
                                elif modifier_name == "Rank":
                                    row['rank'] = "Unknown"
                                elif modifier_name == "Patrol":
                                    row['patrol'] = "Unknown"
                
                order_data.append(row)
    
    return order_data

def create_dynamic_table(order_data):
    """Create and display a dynamic table from order data"""
    if not order_data:
        print("No order data to display in table.")
        return
    
    # Define column headers
    headers = ['Order ID', 'Total Money', 'Line Item Name', 'Scout Name', 'Rank', 'Patrol', 
               'Emergency Contact', 'Emergency Contact Phone', 'Travel to Campout']
    
    # Calculate column widths
    col_widths = []
    for i, header in enumerate(headers):
        width = len(header)
        for row in order_data:
            if i == 0:  # Order ID
                width = max(width, len(row['order_id']))
            elif i == 1:  # Total Money
                width = max(width, len(row['total_money']))
            elif i == 2:  # Line Item Name
                width = max(width, len(row['line_item_name']))
            elif i == 3:  # Scout Name
                width = max(width, len(row['scout_name']))
            elif i == 4:  # Rank
                width = max(width, len(row['rank']))
            elif i == 5:  # Patrol
                width = max(width, len(row['patrol']))
            elif i == 6:  # Emergency Contact
                width = max(width, len(row['emergency_contact']))
            elif i == 7:  # Emergency Contact Phone
                width = max(width, len(row['emergency_contact_phone']))
            elif i == 8:  # Travel to Campout
                width = max(width, len(row['travel_to_campout']))
        col_widths.append(width + 2)  # Add padding
    
    # Create header row
    header_row = "|"
    separator_row = "|"
    for i, header in enumerate(headers):
        header_row += f" {header.ljust(col_widths[i] - 2)} |"
        separator_row += "-" * col_widths[i] + "|"
    
    # Print table
    print("\nDynamic Order Table:")
    print("=" * len(header_row))
    print(header_row)
    print(separator_row)
    
    # Print data rows
    for row in order_data:
        data_row = "|"
        data_row += f" {row['order_id'].ljust(col_widths[0] - 2)} |"
        data_row += f" {row['total_money'].ljust(col_widths[1] - 2)} |"
        data_row += f" {row['line_item_name'].ljust(col_widths[2] - 2)} |"
        data_row += f" {row['scout_name'].ljust(col_widths[3] - 2)} |"
        data_row += f" {row['rank'].ljust(col_widths[4] - 2)} |"
        data_row += f" {row['patrol'].ljust(col_widths[5] - 2)} |"
        data_row += f" {row['emergency_contact'].ljust(col_widths[6] - 2)} |"
        data_row += f" {row['emergency_contact_phone'].ljust(col_widths[7] - 2)} |"
        data_row += f" {row['travel_to_campout'].ljust(col_widths[8] - 2)} |"
        print(data_row)
    
    print("=" * len(header_row))

def main():
    """Main function to fetch and display recent orders with modifier details"""
    print("Fetching recent orders from Square API...")
    orders = get_recent_orders()
    
    if not orders:
        print("No orders found.")
        return
    
    # Extract modifier list IDs from orders
    catalog_versions_dict = extract_modifier_list_ids(orders)
    
    # Get modifier details
    modifier_details = get_modifier_details(catalog_versions_dict)
    
    print("\nOrder Details:")
    print("-" * 50)
    
    for order in orders:
        print(f"Order ID: {order.id}")
        print(f"Total Money: {order.total_money.amount} {order.total_money.currency}")
        
        if hasattr(order, 'line_items') and order.line_items:
            for line_item in order.line_items:
                #print(f"  Line Item UID: {line_item.uid}")
                print(f"  Line Item Name: {line_item.name}")
                #print(f"  Catalog Object ID: {line_item.catalog_object_id}")
                #print(f"  Catalog Version: {line_item.catalog_version}")
                #print(f"  Variation Name: {line_item.variation_name}")
                
                if hasattr(line_item, 'modifiers') and line_item.modifiers:
                    for modifier in line_item.modifiers:
                        #print(f"    Modifier UID: {modifier.uid}")
                        # Get the actual modifier name from the modifier details
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
                                            print(f"    {key}: {value} - {modifier_name}")
                                        else:
                                            print(f"    {key}: {value}")
                                    else:
                                        # If no colon in modifier list name, treat it as key and modifier name as value
                                        print(f"    {modifier_list_name}: {modifier_name}")
                        else:
                            # For modifiers without modifier list, split modifier name into key and value if it contains ":"
                            if ":" in modifier_name:
                                key, value = modifier_name.split(":", 1)
                                key = key.strip()
                                value = value.strip()
                                print(f"    {key}: {value}")
                            else:
                                print(f"    Modifier Name: {modifier_name}")
                print()  # Empty line for separation
        print("-" * 50)
    
    # Extract structured data for table
    order_data = extract_order_data(orders, modifier_details)
    
    # Create and display dynamic table
    create_dynamic_table(order_data)

if __name__ == "__main__":
    main()
