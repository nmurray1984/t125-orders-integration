# Square API Documentation for Order Processing

This document details two key Square APIs used in the order processing system: the Orders API and the Catalog API. These APIs are used to retrieve order information and associated modifier details for training purposes.

## 1. Orders API - Search Endpoint

### Overview
The Search Orders endpoint retrieves orders from a merchant's Square account based on specified criteria. In our implementation, we're using it to fetch the most recent orders for a specific location.

### API Call
```python
result = client.orders.search(
    location_ids=["LRG8TDY17X9VD"],
    limit=5
)
```

### Parameters
- `location_ids` (list of strings, required): The location IDs to filter the orders. In our case, we're using a single location ID.
- `limit` (integer, optional): The maximum number of orders to return in a single response. We're limiting to 5 orders.

### Response Structure
The response contains the following key fields:
- `orders` (list of Order objects): The list of orders matching the search criteria
- `errors` (list of Error objects): Any errors that occurred during the API call

### Order Object Structure
Each Order object contains:
- `id` (string): The unique identifier for the order
- `total_money` (Money object): The total amount of the order
  - `amount` (integer): The amount in the smallest currency unit (e.g., cents for USD)
  - `currency` (string): The currency code (e.g., "USD")
- `line_items` (list of LineItem objects): The items included in the order
  - `uid` (string): Unique identifier for the line item
  - `name` (string): The name of the line item
  - `catalog_object_id` (string): The ID of the catalog object associated with this item
  - `catalog_version` (integer): The version of the catalog object
  - `variation_name` (string): The name of the item variation
  - `modifiers` (list of OrderLineItemModifier objects): Any modifiers applied to the line item
    - `uid` (string): Unique identifier for the modifier
    - `name` (string): The name of the modifier
    - `catalog_object_id` (string): The ID of the catalog object for this modifier

## 2. Catalog API - Batch Get Endpoint

### Overview
The Batch Get endpoint retrieves a list of catalog objects based on their IDs. This API is used to fetch detailed information about modifiers and modifier lists associated with orders.

### API Call
```python
result = client.catalog.batch_get(
    object_ids=object_ids,
    catalog_version=catalog_version
)
```

### Parameters
- `object_ids` (list of strings, required): The IDs of the catalog objects to retrieve
- `catalog_version` (integer, optional): The specific version of the catalog objects to retrieve

### Response Structure
The response contains the following key fields:
- `objects` (list of CatalogObject): The catalog objects that were requested
- `errors` (list of Error objects): Any errors that occurred during the API call

### CatalogObject Structure
Each CatalogObject contains:
- `id` (string): The unique identifier for the catalog object
- `type` (string): The type of catalog object (e.g., "MODIFIER", "MODIFIER_LIST")
- `version` (integer): The version of the catalog object
- `modifier_data` (CatalogModifier): Present when the object type is "MODIFIER"
  - `name` (string): The name of the modifier
  - `modifier_list_id` (string): The ID of the modifier list this modifier belongs to
- `modifier_list_data` (CatalogModifierList): Present when the object type is "MODIFIER_LIST"
  - `name` (string): The name of the modifier list
  - `modifiers` (list of CatalogObject IDs): The IDs of modifiers in this list

### Usage in Code
This API is called in two functions:
1. `get_modifier_details()` - To retrieve details of modifiers associated with line items
2. `get_modifier_list_details()` - To retrieve details of modifier lists when a modifier has a modifier_list_id

The implementation groups object IDs by catalog version to make separate API calls for each version, ensuring we get the correct data for each order's catalog version.
