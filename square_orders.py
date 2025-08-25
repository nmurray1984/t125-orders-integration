from square import Square
from square.environment import SquareEnvironment

client = Square(
    environment=SquareEnvironment.PRODUCTION,
    token="***REMOVED***"
)

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
    """Main function to fetch and display recent orders"""
    print("Fetching recent orders from Square API...")
    orders = get_recent_orders()
    
    if not orders:
        print("No orders found.")
        return
    
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
                        print(f"    Modifier Name: {modifier.name}")
                        print(f"    Modifier Catalog Object ID:  {modifier.catalog_object_id}")
                        print(f"    Modifier Catalog Version:  {modifier.catalog_version}")
                print()  # Empty line for separation
        print("-" * 50)

if __name__ == "__main__":
    main()
