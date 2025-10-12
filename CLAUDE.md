# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Python-based Square API integration project that fetches order data from Square's Orders API and extracts structured information (scout/scouter names, ranks, patrols, emergency contacts, etc.) from order modifiers. The data is output as CSV to stdout for use in camp registration management.

## Key Commands

### Setup
```bash
pip install -r requirements.txt
```

### Run the Application
```bash
python square_orders.py
```
This fetches the most recent orders from Square and outputs CSV data to stdout.

### Run Tests
```bash
python test_square_orders.py
```
Runs unit tests using mock Square API data (no actual API calls).

## Architecture

### Core Data Flow

1. **Order Retrieval** (`get_recent_orders()` in square_orders.py:89)
   - Fetches recent orders from Square Orders API
   - Hard-coded location ID: `"LRG8TDY17X9VD"`
   - Configurable fetch limit: `FETCH_LIMIT = 70`

2. **Modifier Extraction** (`extract_modifier_list_ids()` in square_orders.py:14)
   - Extracts catalog object IDs from order line item modifiers
   - Groups modifiers by catalog version (critical for API calls)
   - Returns: `{catalog_version: [object_ids]}`

3. **Modifier Details Retrieval** (`get_modifier_details()` in square_orders.py:29)
   - Fetches modifier metadata using Square Catalog API batch_get
   - Must be called separately per catalog version
   - Returns enriched modifier data including modifier list IDs

4. **Modifier List Resolution** (`get_modifier_list_details()` in square_orders.py:56)
   - Fetches modifier list metadata when modifiers belong to lists
   - Also grouped by catalog version
   - Used to determine the semantic meaning of modifiers (e.g., "Scout Name:", "Rank:")

5. **Data Extraction** (`extract_order_data()` in square_orders.py:103)
   - Transforms raw Square data into structured row format
   - Key logic: Parses modifier names and modifier list names to extract key-value pairs
   - Handles two formats:
     - Modifiers with colons: "Scout Name: John Smith" → extracts both key and value
     - Modifiers with lists: Uses modifier list name as key, modifier name as value
   - Maps to output columns: scout_name, scouter_name, rank, patrol, emergency_contact, emergency_contact_phone, cell_phone, travel_to_campout

6. **CSV Output** (`create_dynamic_table()` in square_orders.py:256)
   - Writes structured data as CSV to stdout
   - Combines scout_name and scouter_name into single "Name" column
   - Default patrol: "Rocking Chair" if not specified

### Square API Integration

**Authentication**: Hardcoded access token in square_orders.py:9 (line 9 contains production token)

**Environment**: Production (SquareEnvironment.PRODUCTION)

**Key APIs Used**:
- `client.orders.search()` - Fetches orders by location
- `client.catalog.batch_get()` - Fetches catalog objects (modifiers/modifier lists)

**Important**: All Catalog API calls must specify `catalog_version` parameter. Each order line item has its own catalog version, and modifiers must be fetched using the correct version.

### Testing Architecture

**Mock Data** (mock_square_data.py): Complete mock implementations of Square API responses including:
- Mock order objects with line items and modifiers
- Mock catalog objects (modifiers and modifier lists)
- Helper functions that mimic API response structure

**Tests** (test_square_orders.py): Unit tests that exercise individual functions using mock data without API calls.

## Important Implementation Notes

### Catalog Versioning
The Square Catalog uses versioning to track changes over time. When fetching catalog objects:
- Always group object IDs by catalog version (see square_orders.py:33-40, 64-86)
- Make separate batch_get calls for each version
- Mixing versions in a single call will cause errors

### Modifier Data Structure
Modifiers can exist in two forms:
1. **Standalone modifiers**: Simple key-value pairs encoded in the modifier name
2. **List-based modifiers**: Modifier belongs to a modifier_list, where the list provides context
   - Example: Modifier "John Smith" in list "Scout Name:"
   - Requires additional API call to fetch modifier list details

### Data Extraction Logic
The code at square_orders.py:176-191 contains the core mapping logic:
- Extracts keys from modifier list names (e.g., "Scout Name:")
- Combines with modifier values to create semantic data
- Maps known keys to specific output columns

### Default Values
- Empty patrol defaults to "Rocking Chair" (square_orders.py:276)
- Name field prioritizes scout_name over scouter_name (square_orders.py:275)

## Configuration

**Access Token**: square_orders.py:9 (currently contains production token - should be moved to environment variable)

**Location ID**: square_orders.py:93 (hardcoded as "LRG8TDY17X9VD")

**Fetch Limit**: square_orders.py:12 (currently set to 70 orders)

**Square Environment**: square_orders.py:8 (set to PRODUCTION)
