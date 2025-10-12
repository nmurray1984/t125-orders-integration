# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Python-based Square API integration project that fetches order data from Square's Orders API and extracts structured information (scout/scouter names, ranks, patrols, emergency contacts, etc.) from order modifiers. The data can be output as CSV to stdout or written directly to Google Sheets for automated camp registration management.

## Key Commands

### Setup
```bash
pip install -r requirements.txt
```

### Run the Application

**Output to stdout (CSV)**:
```bash
python square_orders.py
# or explicitly:
python square_orders.py --output stdout
```

**Write to Google Sheets**:
```bash
python square_orders.py --output sheets
```

This fetches the most recent orders from Square and either outputs CSV data to stdout or writes to Google Sheets based on the `--output` flag.

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

6. **Output** (square_orders.py:258-293)
   - `write_csv_to_stdout()`: Writes structured data as CSV to stdout
   - `write_to_google_sheet()`: Writes data to Google Sheets (imported from google_sheets.py)
   - Combines scout_name and scouter_name into single "Name" column
   - Default patrol: "Rocking Chair" if not specified

### Square API Integration

**Authentication**: Uses environment variable `SQUARE_ACCESS_TOKEN` (configured in config.py)

**Environment**: Production (SquareEnvironment.PRODUCTION)

**Key APIs Used**:
- `client.orders.search()` - Fetches orders by location
- `client.catalog.batch_get()` - Fetches catalog objects (modifiers/modifier lists)

**Important**: All Catalog API calls must specify `catalog_version` parameter. Each order line item has its own catalog version, and modifiers must be fetched using the correct version.

### Google Sheets Integration

**Module**: google_sheets.py

**Authentication**: Uses Google Service Account credentials from `GOOGLE_CREDENTIALS_JSON` environment variable

**Key Functions**:
- `get_sheets_service()`: Creates authenticated Google Sheets API service
- `write_to_google_sheet()`: Writes order data to specified Google Sheet
  - Supports two modes: 'overwrite' (clears and rewrites) and 'append' (adds to existing data)
  - Automatically formats data with headers
  - Returns success/failure status

**Configuration**: See config.py for all Google Sheets related environment variables

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

All configuration is managed through environment variables (see config.py). Set these variables before running the application.

### Required Environment Variables

**For Square API (always required)**:
- `SQUARE_ACCESS_TOKEN`: Square API access token
- `SQUARE_LOCATION_ID`: Square location ID (e.g., "LRG8TDY17X9VD")

**For Google Sheets output (required when using `--output sheets`)**:
- `GOOGLE_SHEET_ID`: Target Google Spreadsheet ID
- `GOOGLE_CREDENTIALS_JSON`: Service account credentials as JSON string

### Optional Environment Variables

- `SQUARE_FETCH_LIMIT`: Number of orders to fetch (default: 70)
- `SHEET_NAME`: Sheet/tab name in Google Sheets (default: "Sheet1")
- `WRITE_MODE`: Google Sheets write mode - "overwrite" or "append" (default: "overwrite")

### Setting Up Google Sheets Integration

1. **Create a Google Cloud Project**:
   - Go to https://console.cloud.google.com
   - Create a new project or select an existing one

2. **Enable Google Sheets API**:
   - In the Google Cloud Console, go to "APIs & Services" > "Library"
   - Search for "Google Sheets API" and enable it

3. **Create a Service Account**:
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "Service Account"
   - Fill in the service account details and create
   - Click on the created service account
   - Go to "Keys" tab > "Add Key" > "Create New Key" > "JSON"
   - Download the JSON key file

4. **Share Your Google Sheet**:
   - Open your target Google Sheet
   - Click "Share" button
   - Add the service account email (found in the JSON key file as `client_email`)
   - Give it "Editor" permissions

5. **Set Environment Variables**:
   ```bash
   export SQUARE_ACCESS_TOKEN="your_square_token"
   export SQUARE_LOCATION_ID="your_location_id"
   export GOOGLE_SHEET_ID="your_sheet_id"  # From the sheet URL
   export GOOGLE_CREDENTIALS_JSON='{"type":"service_account",...}'  # Contents of JSON key file
   ```

### GitHub Actions Automation

The project includes a GitHub Actions workflow (`.github/workflows/nightly-sync.yml`) that runs nightly at 6 AM UTC.

**Setup**:
1. Go to your GitHub repository > Settings > Secrets and variables > Actions
2. Add the following secrets:
   - `SQUARE_ACCESS_TOKEN`
   - `SQUARE_LOCATION_ID`
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_CREDENTIALS_JSON`
   - `SHEET_NAME` (optional)
   - `WRITE_MODE` (optional)

3. The workflow will run automatically every night and can also be triggered manually from the Actions tab.
