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
            limit=2
        )
        if hasattr(result, 'errors') and result.errors:
            print(f"API returned errors: {result.errors}")
        return result.orders if hasattr(result, 'orders') and result.orders else []
    except Exception as e:
        print(f"Error fetching orders: {e}")
        return []

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
                print(f"  Line Item UID: {line_item.uid}")
                print(f"  Line Item Name: {line_item.name}")
                print(f"  Catalog Object ID: {line_item.catalog_object_id}")
                print(f"  Catalog Version: {line_item.catalog_version}")
                print(f"  Variation Name: {line_item.variation_name}")
                
                if hasattr(line_item, 'modifiers') and line_item.modifiers:
                    for modifier in line_item.modifiers:
                        print(f"    Modifier UID: {modifier.uid}")
                        # Get the actual modifier name from the modifier details
                        modifier_name = modifier.name
                        if modifier.catalog_object_id in modifier_details:
                            obj = modifier_details[modifier.catalog_object_id]
                            if hasattr(obj, 'modifier_data') and hasattr(obj.modifier_data, 'name'):
                                modifier_name = obj.modifier_data.name
                        
                        print(f"    Modifier Name: {modifier_name}")
                        print(f"    Modifier Catalog Object ID:  {modifier.catalog_object_id}")
                        print(f"    Modifier Catalog Version:  {modifier.catalog_version}")
                        
                        # If modifier has modifier_list_id, get the modifier list name
                        if modifier.catalog_object_id in modifier_details:
                            obj = modifier_details[modifier.catalog_object_id]
                            if hasattr(obj, 'modifier_data') and hasattr(obj.modifier_data, 'modifier_list_id'):
                                modifier_list_id = obj.modifier_data.modifier_list_id
                                # Get modifier list details
                                modifier_list_details = get_modifier_list_details([{
                                    'catalog_version': line_item.catalog_version,
                                    'object_id': modifier_list_id
                                }])
                                
                                if modifier_list_id in modifier_list_details:
                                    modifier_list_obj = modifier_list_details[modifier_list_id]
                                    if hasattr(modifier_list_obj, 'modifier_list_data') and hasattr(modifier_list_obj.modifier_list_data, 'name'):
                                        print(f"    Modifier List Name: {modifier_list_obj.modifier_list_data.name}")
                print()  # Empty line for separation
        print("-" * 50)

if __name__ == "__main__":
    main()
