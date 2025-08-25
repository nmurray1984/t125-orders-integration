from square import Square
from square.environment import SquareEnvironment

client = Square(
    environment=SquareEnvironment.PRODUCTION,
    token="***REMOVED***"
)

def get_recent_orders():
    """Fetch the 30 most recent orders from Square API"""
    #try:
    result = client.orders.search(
            location_ids=["LRG8TDY17X9VD"],
            limit=2
    )
    print(f"API call successful. Result: {result}")
        #if hasattr(result, 'errors') and result.errors:
        #    print(f"API returned errors: {result.errors}")
        #return result.result.orders if hasattr(result.result, 'orders') and result.result.orders else []
    #except Exception as e:
        #print(f"Error fetching orders: {e}")
        #return []

def main():
    """Main function to fetch and display recent orders"""
    print("Fetching recent orders from Square API...")
    orders = get_recent_orders()

if __name__ == "__main__":
    main()
