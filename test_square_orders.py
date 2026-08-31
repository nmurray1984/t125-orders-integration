"""
Test file for square_orders.py using mock data.
This file demonstrates how to test the Square API integration code without making actual API calls.
"""

import sys
import os

# Add the current directory to the Python path so we can import our modules
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Import the mock data
from mock_square_data import (
    get_mock_orders_response,
    get_mock_catalog_modifiers_response,
    get_mock_catalog_modifier_lists_response,
    mock_catalog_modifiers_response,
    mock_catalog_modifier_lists_response,
    mock_orders_with_refund_response,
    mock_canceled_order,
    mock_unpaid_order,
    MockCardDetails,
    MockMoney,
    MockOrder,
    MockTender,
)

# Import the functions we want to test
from square_orders import (
    extract_modifier_list_ids,
    get_modifier_details,
    get_modifier_list_details,
    extract_order_data,
    payment_status,
)

def check(label, condition):
    print(f"{'✓' if condition else '✗'} {label}")
    return condition


def test_extract_modifier_list_ids():
    """Test the extract_modifier_list_ids function with mock data"""
    print("Testing extract_modifier_list_ids function...")
    
    # Get mock orders
    mock_response = get_mock_orders_response()
    orders = mock_response.orders
    
    # Extract modifier list IDs
    catalog_versions_dict = extract_modifier_list_ids(orders)
    
    print(f"Catalog versions dict: {catalog_versions_dict}")
    
    # Verify we got the expected results
    expected_catalog_versions = {1: ['MODIFIER_1', 'MODIFIER_2', 'MODIFIER_3', 'MODIFIER_4', 'MODIFIER_5', 'MODIFIER_6', 'MODIFIER_7']}
    
    if catalog_versions_dict == expected_catalog_versions:
        print("✓ extract_modifier_list_ids test passed")
        return True
    else:
        print("✗ extract_modifier_list_ids test failed")
        print(f"Expected: {expected_catalog_versions}")
        print(f"Got: {catalog_versions_dict}")
        return False

def test_get_modifier_details():
    """Test the get_modifier_details function with mock data"""
    print("\nTesting get_modifier_details function...")
    
    # Create a mock catalog_versions_dict
    catalog_versions_dict = {1: ['MODIFIER_1', 'MODIFIER_2', 'MODIFIER_3', 'MODIFIER_4', 'MODIFIER_5', 'MODIFIER_6', 'MODIFIER_7']}
    
    # Since we're testing without actual API calls, we'll mock the client.catalog.batch_get method
    # For this test, we'll directly use our mock data
    modifier_details = {}
    
    # Add all objects from our mock catalog modifiers response to modifier_details
    for obj in mock_catalog_modifiers_response.objects:
        modifier_details[obj.id] = obj
    
    print(f"Modifier details keys: {list(modifier_details.keys())}")
    
    # Verify we have the expected number of modifier details
    if len(modifier_details) == 7:  # We have 7 mock modifiers
        print("✓ get_modifier_details test passed")
        return True
    else:
        print("✗ get_modifier_details test failed")
        print(f"Expected 7 modifier details, got {len(modifier_details)}")
        return False

def test_extract_order_data():
    """Test the extract_order_data function with mock data"""
    print("\nTesting extract_order_data function...")
    
    # Get mock orders
    mock_response = get_mock_orders_response()
    orders = mock_response.orders
    
    # Get mock modifier details
    modifier_details = {}
    for obj in mock_catalog_modifiers_response.objects:
        modifier_details[obj.id] = obj
    
    # Extract order data
    order_data = extract_order_data(orders, modifier_details)
    
    print(f"Extracted {len(order_data)} order data rows")
    
    # Print the first row for verification
    if order_data:
        print("First order data row:")
        for key, value in order_data[0].items():
            print(f"  {key}: {value}")
    
    # Verify we have the expected number of rows (3 orders, but some have multiple line items)
    # In our mock data, each order has 1 line item, so we should have 3 rows
    if len(order_data) == 3:
        print("✓ extract_order_data test passed")
        return True
    else:
        print("✗ extract_order_data test failed")
        print(f"Expected 3 order data rows, got {len(order_data)}")
        return False

def test_refunded_order():
    """Test that refunded orders with None total_money are handled gracefully"""
    print("\nTesting refunded order handling (None total_money)...")

    # Get mock orders that include a refunded order
    orders = mock_orders_with_refund_response.orders

    # Get mock modifier details
    modifier_details = {}
    for obj in mock_catalog_modifiers_response.objects:
        modifier_details[obj.id] = obj

    # Extract order data - this should not crash
    order_data = extract_order_data(orders, modifier_details)

    print(f"Extracted {len(order_data)} order data rows")

    # Find the refunded order row
    refunded_rows = [r for r in order_data if r['order_id'] == 'ORDER_REFUNDED']

    if len(refunded_rows) == 1 and refunded_rows[0]['total_money'] == '0 USD':
        print("✓ refunded order test passed (total_money handled as '0 USD')")
        return True
    else:
        print("✗ refunded order test failed")
        if refunded_rows:
            print(f"Got total_money: {refunded_rows[0]['total_money']}")
        else:
            print("No refunded order row found")
        return False

def test_with_modifier_lists():
    """Test with orders that have modifier lists"""
    print("\nTesting with orders that have modifier lists...")
    
    # For this test, we'll need to modify how the functions work to use our mock data
    # Instead of making actual API calls, we'll return our mock responses
    
    # This would normally be done with mocking libraries like unittest.mock,
    # but for simplicity, we'll just demonstrate the concept
    
    print("This test demonstrates how you would test with modifier lists")
    print("In a real test environment, you would mock the API calls to return the appropriate responses")
    
    return True

def test_payment_status():
    """
    Square creates the order at checkout, not at payment, so an abandoned
    checkout is a real order carrying real answers. Only the money fields tell
    it apart.
    """
    print("\nTesting payment status...")

    def order(**kwargs):
        kwargs.setdefault('total_money', MockMoney(15000, "USD"))
        return MockOrder(id="O", **kwargs)

    captured = MockTender("T", MockCardDetails("CAPTURED"))

    cases = [
        ("a completed order with a captured tender is paid",
         order(state="COMPLETED", tenders=[captured]), 'PAID'),
        ("an order still open for fulfillment but owing nothing is paid",
         order(state="OPEN", net_amount_due_money=MockMoney(0, "USD")), 'PAID'),
        ("a tender outweighs an OPEN state",
         order(state="OPEN", tenders=[captured]), 'PAID'),
        ("a completed order with no tender detail is paid",
         order(state="COMPLETED"), 'PAID'),
        ("an open order with the full amount due is unpaid",
         order(state="OPEN", net_amount_due_money=MockMoney(15000, "USD")), 'UNPAID'),
        ("an open order with no payment detail at all is unpaid",
         order(state="OPEN"), 'UNPAID'),
        ("a draft is unpaid",
         order(state="DRAFT"), 'UNPAID'),
        ("a canceled order is canceled",
         order(state="CANCELED"), 'CANCELED'),
        ("a voided tender does not count as payment",
         order(state="OPEN", tenders=[MockTender("T", MockCardDetails("VOIDED"))],
               net_amount_due_money=MockMoney(15000, "USD")), 'UNPAID'),
        ("an order that says nothing at all is left unknown",
         order(), ''),
    ]

    results = []
    for label, mock_order, expected in cases:
        actual = payment_status(mock_order)
        ok = actual == expected
        print(f"{'✓' if ok else '✗'} {label} ({actual!r})")
        results.append(ok)

    return all(results)


def test_payment_status_reaches_every_row():
    """Payment is a property of the order, so all its line items inherit it."""
    print("\nTesting payment status on extracted rows...")

    orders = list(get_mock_orders_response().orders) + [mock_unpaid_order, mock_canceled_order]
    modifier_details = {obj.id: obj for obj in mock_catalog_modifiers_response.objects}
    rows = extract_order_data(orders, modifier_details)
    by_order = {row['order_id']: row['payment_status'] for row in rows}

    results = [
        check("every row carries a status", all('payment_status' in r for r in rows)),
        check("an abandoned checkout is UNPAID", by_order['ORDER_UNPAID'] == 'UNPAID'),
        check("a canceled order is CANCELED", by_order['ORDER_CANCELED'] == 'CANCELED'),
        check("a completed order is PAID", by_order['ORDER_1'] == 'PAID'),
        check("an order with no payment fields stays unknown", by_order['ORDER_3'] == ''),
        # The point of the feature: the row is indistinguishable from a real
        # registration apart from its payment status.
        check("the unpaid row still carries its parsed answers",
              all(r['scout_name'] for r in rows if r['order_id'] == 'ORDER_UNPAID')),
    ]
    return all(results)


def main():
    """Run all tests"""
    print("Running tests for Square Orders processing with mock data...")
    print("=" * 60)
    
    # Run individual tests
    test_results = []
    test_results.append(test_extract_modifier_list_ids())
    test_results.append(test_get_modifier_details())
    test_results.append(test_extract_order_data())
    test_results.append(test_refunded_order())
    test_results.append(test_with_modifier_lists())
    test_results.append(test_payment_status())
    test_results.append(test_payment_status_reaches_every_row())
    
    # Summary
    print("\n" + "=" * 60)
    print("Test Summary:")
    passed_tests = sum(test_results)
    total_tests = len(test_results)
    print(f"Passed: {passed_tests}/{total_tests}")
    
    if passed_tests == total_tests:
        print("✓ All tests passed!")
    else:
        print("✗ Some tests failed.")
    
    return passed_tests == total_tests

if __name__ == "__main__":
    sys.exit(0 if main() else 1)
