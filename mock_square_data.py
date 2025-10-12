"""
Mock data for testing Square API integration without making actual API calls.
This file contains mock responses that mimic the structure of real Square API responses.
"""

class MockMoney:
    def __init__(self, amount, currency):
        self.amount = amount
        self.currency = currency

class MockModifier:
    def __init__(self, uid, name, catalog_object_id):
        self.uid = uid
        self.name = name
        self.catalog_object_id = catalog_object_id

class MockLineItem:
    def __init__(self, uid, name, catalog_object_id, catalog_version, variation_name, modifiers=None):
        self.uid = uid
        self.name = name
        self.catalog_object_id = catalog_object_id
        self.catalog_version = catalog_version
        self.variation_name = variation_name
        self.modifiers = modifiers or []

class MockOrder:
    def __init__(self, id, total_money, line_items=None):
        self.id = id
        self.total_money = total_money
        self.line_items = line_items or []

class MockModifierData:
    def __init__(self, name, modifier_list_id=None):
        self.name = name
        self.modifier_list_id = modifier_list_id

class MockModifierListData:
    def __init__(self, name, modifiers=None):
        self.name = name
        self.modifiers = modifiers or []

class MockCatalogObject:
    def __init__(self, id, type, version, modifier_data=None, modifier_list_data=None):
        self.id = id
        self.type = type
        self.version = version
        self.modifier_data = modifier_data
        self.modifier_list_data = modifier_list_data

class MockAPIResponse:
    def __init__(self, orders=None, objects=None, errors=None):
        self.orders = orders or []
        self.objects = objects or []
        self.errors = errors or []

# Mock Orders API response
mock_orders_response = MockAPIResponse(
    orders=[
        MockOrder(
            id="ORDER_1",
            total_money=MockMoney(15000, "USD"),
            line_items=[
                MockLineItem(
                    uid="LINE_ITEM_1_1",
                    name="Camp Registration",
                    catalog_object_id="CATALOG_ITEM_1",
                    catalog_version=1,
                    variation_name="Basic Registration",
                    modifiers=[
                        MockModifier(
                            uid="MODIFIER_1_1_1",
                            name="Scout Name: John Smith",
                            catalog_object_id="MODIFIER_1"
                        ),
                        MockModifier(
                            uid="MODIFIER_1_1_2",
                            name="Rank",
                            catalog_object_id="MODIFIER_2"
                        )
                    ]
                )
            ]
        ),
        MockOrder(
            id="ORDER_2",
            total_money=MockMoney(25000, "USD"),
            line_items=[
                MockLineItem(
                    uid="LINE_ITEM_2_1",
                    name="Camp Registration",
                    catalog_object_id="CATALOG_ITEM_1",
                    catalog_version=1,
                    variation_name="Premium Registration",
                    modifiers=[
                        MockModifier(
                            uid="MODIFIER_2_1_1",
                            name="Scout Name: Jane Doe",
                            catalog_object_id="MODIFIER_3"
                        ),
                        MockModifier(
                            uid="MODIFIER_2_1_2",
                            name="Scouter Name: Bob Doe",
                            catalog_object_id="MODIFIER_4"
                        ),
                        MockModifier(
                            uid="MODIFIER_2_1_3",
                            name="Emergency Contact: Alice Doe",
                            catalog_object_id="MODIFIER_5"
                        )
                    ]
                )
            ]
        ),
        MockOrder(
            id="ORDER_3",
            total_money=MockMoney(10000, "USD"),
            line_items=[
                MockLineItem(
                    uid="LINE_ITEM_3_1",
                    name="Camp Registration",
                    catalog_object_id="CATALOG_ITEM_1",
                    catalog_version=1,
                    variation_name="Basic Registration",
                    modifiers=[
                        MockModifier(
                            uid="MODIFIER_3_1_1",
                            name="Patrol",
                            catalog_object_id="MODIFIER_6"
                        ),
                        MockModifier(
                            uid="MODIFIER_3_1_2",
                            name="Will you travel with the troop to the campout?",
                            catalog_object_id="MODIFIER_7"
                        )
                    ]
                )
            ]
        )
    ]
)

# Mock Catalog API response for modifiers
mock_catalog_modifiers_response = MockAPIResponse(
    objects=[
        MockCatalogObject(
            id="MODIFIER_1",
            type="MODIFIER",
            version=1,
            modifier_data=MockModifierData(
                name="Scout Name: John Smith"
            )
        ),
        MockCatalogObject(
            id="MODIFIER_2",
            type="MODIFIER",
            version=1,
            modifier_data=MockModifierData(
                name="Rank: Tenderfoot"
            )
        ),
        MockCatalogObject(
            id="MODIFIER_3",
            type="MODIFIER",
            version=1,
            modifier_data=MockModifierData(
                name="Scout Name: Jane Doe"
            )
        ),
        MockCatalogObject(
            id="MODIFIER_4",
            type="MODIFIER",
            version=1,
            modifier_data=MockModifierData(
                name="Scouter Name: Bob Doe"
            )
        ),
        MockCatalogObject(
            id="MODIFIER_5",
            type="MODIFIER",
            version=1,
            modifier_data=MockModifierData(
                name="Emergency Contact: Alice Doe"
            )
        ),
        MockCatalogObject(
            id="MODIFIER_6",
            type="MODIFIER",
            version=1,
            modifier_data=MockModifierData(
                name="Patrol: Eagle Patrol"
            )
        ),
        MockCatalogObject(
            id="MODIFIER_7",
            type="MODIFIER",
            version=1,
            modifier_data=MockModifierData(
                name="Will you travel with the troop to the campout?: Yes"
            )
        )
    ]
)

# Mock Catalog API response for modifier lists
mock_catalog_modifier_lists_response = MockAPIResponse(
    objects=[
        MockCatalogObject(
            id="MODIFIER_LIST_1",
            type="MODIFIER_LIST",
            version=1,
            modifier_list_data=MockModifierListData(
                name="Scout Information",
                modifiers=["MODIFIER_1", "MODIFIER_2"]
            )
        )
    ]
)

# Additional mock data for testing different scenarios
mock_orders_with_modifier_lists_response = MockAPIResponse(
    orders=[
        MockOrder(
            id="ORDER_4",
            total_money=MockMoney(20000, "USD"),
            line_items=[
                MockLineItem(
                    uid="LINE_ITEM_4_1",
                    name="Camp Registration",
                    catalog_object_id="CATALOG_ITEM_1",
                    catalog_version=2,
                    variation_name="Standard Registration",
                    modifiers=[
                        MockModifier(
                            uid="MODIFIER_4_1_1",
                            name="Basic Modifier",
                            catalog_object_id="MODIFIER_8"
                        )
                    ]
                )
            ]
        )
    ]
)

# Mock Catalog API response with modifier that has a modifier list
mock_catalog_modifiers_with_list_response = MockAPIResponse(
    objects=[
        MockCatalogObject(
            id="MODIFIER_8",
            type="MODIFIER",
            version=2,
            modifier_data=MockModifierData(
                name="Special Accommodation",
                modifier_list_id="MODIFIER_LIST_1"
            )
        )
    ]
)

# Empty responses for testing edge cases
mock_empty_orders_response = MockAPIResponse(orders=[])

mock_orders_with_errors_response = MockAPIResponse(
    orders=[],
    errors=[{"category": "INVALID_REQUEST_ERROR", "code": "NOT_FOUND", "detail": "No orders found"}]
)

# Function to get mock orders response
def get_mock_orders_response():
    return mock_orders_response

# Function to get mock catalog modifiers response
def get_mock_catalog_modifiers_response(object_ids, catalog_version=None):
    # In a real implementation, we would filter based on object_ids and catalog_version
    # For simplicity in testing, we return the full mock response
    return mock_catalog_modifiers_response

# Function to get mock catalog modifier lists response
def get_mock_catalog_modifier_lists_response(object_ids, catalog_version=None):
    # In a real implementation, we would filter based on object_ids and catalog_version
    # For simplicity in testing, we return the full mock response
    return mock_catalog_modifier_lists_response
